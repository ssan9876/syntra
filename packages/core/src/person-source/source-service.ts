import type { TenantClient } from '@syntra/db';
import { personSourceConfigSchemaFor } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { deleteSecret, getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { unassignablePersonFields, type PersonMappingRule } from './mapping.js';

export const FEED_MODES = ['snapshot', 'delta'] as const;
export type FeedMode = (typeof FEED_MODES)[number];

export class UnassignableFieldError extends Error {
  constructor(readonly fields: string[]) {
    super(
      `a mapping may not write ${fields.join(', ')}: those fields are ` +
        `Syntra's, not the source's`,
    );
    this.name = 'UnassignableFieldError';
  }
}

export class PersonSourceOwnsPersonsError extends Error {
  constructor(readonly persons: number) {
    super(
      `this source owns ${persons} people; deleting it deactivates and ` +
        `detaches them, which has to be confirmed`,
    );
    this.name = 'PersonSourceOwnsPersonsError';
  }
}

export class PersonSourceDisabledError extends Error {
  constructor(readonly sourceId: string) {
    super('this source is disabled, so a run would never be picked up');
    this.name = 'PersonSourceDisabledError';
  }
}

export interface CreatePersonSourceInput {
  name: string;
  type: string;
  /** No default. See the schema comment on the column. */
  feedMode: FeedMode;
  config: unknown;
  credential: string;
  schedule?: string | undefined;
  autoApply?: boolean | undefined;
  deactivationThresholdPercent?: number | undefined;
  enabled?: boolean | undefined;
}

/**
 * The last place a feed mode could acquire a default by accident.
 *
 * There is none in the schema, none in the migration, none in the Zod contract
 * and none here: a delta file read as a snapshot departs everyone absent from
 * it, which is everyone who did not change yesterday.
 */
function assertFeedMode(value: string): asserts value is FeedMode {
  if (!(FEED_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `"${value}" is not a feed mode; it is "snapshot" or "delta", and there ` +
        `is no default because reading a delta as a snapshot departs everyone ` +
        `absent from it`,
    );
  }
}

export async function createPersonSource(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: CreatePersonSourceInput,
) {
  const tenantId = await currentTenant(tx);
  assertFeedMode(input.feedMode);
  // Throws UnknownPersonSourceTypeError for a type no connector implements,
  // before a row exists to be orphaned by it.
  const config = personSourceConfigSchemaFor(input.type).parse(input.config);

  const source = await tx.personSource.create({
    data: {
      tenantId,
      name: input.name,
      type: input.type,
      feedMode: input.feedMode,
      config: config as never,
      // Filled in below, once the row has an id to name the secret after.
      secretName: 'pending',
      schedule: input.schedule ?? null,
      autoApply: input.autoApply ?? false,
      deactivationThresholdPercent: input.deactivationThresholdPercent ?? 10,
      enabled: input.enabled ?? true,
    },
  });

  const secretName = `personSource.${source.id}.credential`;
  await putSecret(tx, provider, secretName, input.credential);

  return tx.personSource.update({
    where: { id: source.id },
    data: { secretName },
  });
}

export interface UpdatePersonSourceInput {
  name?: string | undefined;
  config?: unknown;
  credential?: string | undefined;
  feedMode?: FeedMode | undefined;
  /** `null` clears the cron expression, leaving the source manual-only. */
  schedule?: string | null | undefined;
  autoApply?: boolean | undefined;
  deactivationThresholdPercent?: number | undefined;
  enabled?: boolean | undefined;
}

export async function updatePersonSource(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
  input: UpdatePersonSourceInput,
) {
  const existing = await tx.personSource.findUnique({ where: { id } });
  if (!existing) return null;

  if (input.feedMode !== undefined) assertFeedMode(input.feedMode);
  const config =
    input.config === undefined
      ? undefined
      : personSourceConfigSchemaFor(existing.type).parse(input.config);

  if (input.credential !== undefined) {
    await putSecret(tx, provider, existing.secretName, input.credential);
  }

  return tx.personSource.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(config === undefined ? {} : { config: config as never }),
      ...(input.feedMode === undefined ? {} : { feedMode: input.feedMode }),
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      ...(input.autoApply === undefined ? {} : { autoApply: input.autoApply }),
      ...(input.deactivationThresholdPercent === undefined
        ? {}
        : { deactivationThresholdPercent: input.deactivationThresholdPercent }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    },
  });
}

export function findPersonSource(tx: TenantClient, id: string) {
  return tx.personSource.findUnique({ where: { id } });
}

export function listPersonSources(tx: TenantClient) {
  return tx.personSource.findMany({ orderBy: { name: 'asc' } });
}

/**
 * The stored configuration merged with the credential from the vault.
 *
 * Plain data, deliberately not a `tx` handle: nothing downstream may hold a
 * transaction open across the SFTP read.
 */
export async function personSourceWithCredential(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
): Promise<Record<string, unknown> | null> {
  const source = await tx.personSource.findUnique({ where: { id } });
  if (!source) return null;
  const credential = await getSecret(tx, provider, source.secretName);
  if (credential === null) return null;

  const config = source.config as Record<string, unknown>;
  // A key is multi-line and carries a PEM banner; anything else is a password.
  // The two share one vault entry because a source has one credential, not one
  // of each.
  const isKey = credential.includes('BEGIN') && credential.includes('PRIVATE KEY');
  return {
    ...config,
    ...(isKey ? { privateKey: credential } : { password: credential }),
  };
}

export async function personMappingsFor(
  tx: TenantClient,
  sourceId: string,
): Promise<PersonMappingRule[]> {
  const rows = await tx.personFieldMapping.findMany({ where: { sourceId } });
  return rows.map((row) => ({
    recordType: row.recordType as PersonMappingRule['recordType'],
    sourceColumn: row.sourceColumn,
    targetField: row.targetField,
    transform: row.transform as PersonMappingRule['transform'],
    isCorrelation: row.isCorrelation,
  }));
}

/**
 * Replaces a source's mappings wholesale.
 *
 * Every rule is checked before anything is written: a set that refused halfway
 * would leave a source mapping some fields and not others, which is a
 * configuration nobody chose and the next run would act on.
 */
export async function setPersonMappings(
  tx: TenantClient,
  sourceId: string,
  rules: PersonMappingRule[],
) {
  const tenantId = await currentTenant(tx);

  for (const recordType of ['person', 'contract'] as const) {
    const offending = unassignablePersonFields(
      recordType,
      rules
        .filter((r) => r.recordType === recordType && !r.isCorrelation)
        .map((r) => r.targetField),
    );
    if (offending.length > 0) throw new UnassignableFieldError(offending);
  }

  const correlations = rules.filter((r) => r.isCorrelation);
  if (correlations.length !== 1) {
    throw new Error(
      `a source needs exactly one correlation rule, which is what anchors a ` +
        `row to a person; this set has ${correlations.length}`,
    );
  }
  if (correlations[0]?.recordType !== 'person') {
    throw new Error(
      'the correlation rule must map a person field, not a contract field',
    );
  }

  await tx.personFieldMapping.deleteMany({ where: { sourceId } });
  await tx.personFieldMapping.createMany({
    data: rules.map((rule) => ({ ...rule, tenantId, sourceId })),
  });
  return personMappingsFor(tx, sourceId);
}

export function personSourceOwnedCount(tx: TenantClient, sourceId: string) {
  return tx.person.count({ where: { sourceId, status: 'active' } });
}

/**
 * Deleting a source, and releasing what it owned.
 *
 * `ON DELETE RESTRICT` forces the detach, and detaching is also what makes
 * those rows honest: a person owned by a source that no longer exists is fed
 * by nothing. They are deactivated and detached in the same transaction as the
 * delete, so releasing them is an act of the code and not only of the schema
 * -- and it is a decision an administrator confirms rather than a side effect
 * of removing a configuration row.
 */
export async function deletePersonSource(
  tx: TenantClient,
  id: string,
  opts: { confirm?: boolean } = {},
): Promise<{ persons: number } | null> {
  const existing = await tx.personSource.findUnique({ where: { id } });
  if (!existing) return null;

  // Counted inside the deleting transaction, so what is checked is what is
  // about to be deactivated rather than what was true a moment ago.
  const persons = await personSourceOwnedCount(tx, id);
  if (persons > 0 && !opts.confirm) throw new PersonSourceOwnsPersonsError(persons);

  const reason = `Person source "${existing.name}" was removed`;
  await tx.person.updateMany({
    where: { sourceId: id, status: 'active' },
    data: { status: 'inactive', statusReason: reason },
  });
  await tx.person.updateMany({ where: { sourceId: id }, data: { sourceId: null } });

  await deleteSecret(tx, existing.secretName);
  await tx.personSource.delete({ where: { id } });
  return { persons };
}
