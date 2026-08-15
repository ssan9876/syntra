import type { TenantClient } from '@syntra/db';
import { ldapConfigSchema, type LdapConfig } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { deleteSecret, getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import {
  ASSIGNABLE_FIELDS,
  unassignableFields,
  type MappingRule,
} from './mapping.js';

export interface CreateSourceInput {
  name: string;
  config: unknown;
  bindPassword: string;
  schedule?: string | undefined;
  autoApply?: boolean | undefined;
  deactivationThresholdPercent?: number | undefined;
}

export async function createSource(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: CreateSourceInput,
) {
  const tenantId = await currentTenant(tx);
  const config = ldapConfigSchema.parse(input.config);

  const source = await tx.directorySource.create({
    data: {
      tenantId,
      name: input.name,
      type: 'ldap',
      config: config as never,
      // Filled in below, once the row has an id to name the secret after.
      secretName: 'pending',
      schedule: input.schedule ?? null,
      autoApply: input.autoApply ?? false,
      deactivationThresholdPercent: input.deactivationThresholdPercent ?? 10,
    },
  });

  const secretName = `source.${source.id}.bindPassword`;
  await putSecret(tx, provider, secretName, input.bindPassword);

  return tx.directorySource.update({
    where: { id: source.id },
    data: { secretName },
  });
}

export interface UpdateSourceInput {
  name?: string | undefined;
  config?: unknown;
  bindPassword?: string | undefined;
  /** `null` clears the cron expression, leaving the source manual-only. */
  schedule?: string | null | undefined;
  autoApply?: boolean | undefined;
  deactivationThresholdPercent?: number | undefined;
  enabled?: boolean | undefined;
}

/**
 * Edits a source in place. Returns `null` if there is no such source, so the
 * caller can answer 404 rather than infer it from a thrown error.
 *
 * Every field is optional and only what was sent is written — a request that
 * changes the schedule must not have to resend the whole connection
 * configuration, and one that changes nothing must not blank anything.
 *
 * `config`, though, is replaced whole rather than merged. It is parsed by
 * `ldapConfigSchema`, which resolves defaults and cross-checks the TLS mode
 * against the URL scheme; merging a fragment over a stored blob would let a
 * half-configuration reach the connector with the checks passing on the
 * fragment alone.
 *
 * A new bind password overwrites the vault entry the source already names.
 * The secret's name is derived from the source id and never changes, so a
 * rotation replaces the credential rather than orphaning the old one.
 */
export async function updateSource(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
  input: UpdateSourceInput,
) {
  const existing = await tx.directorySource.findUnique({ where: { id } });
  if (!existing) return null;

  if (input.bindPassword !== undefined) {
    await putSecret(tx, provider, existing.secretName, input.bindPassword);
  }

  return tx.directorySource.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.config !== undefined
        ? { config: ldapConfigSchema.parse(input.config) as never }
        : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.autoApply !== undefined ? { autoApply: input.autoApply } : {}),
      ...(input.deactivationThresholdPercent !== undefined
        ? { deactivationThresholdPercent: input.deactivationThresholdPercent }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
}

/** Directory rows a source owns, counted before it is removed. */
export interface OwnedObjectCounts {
  users: number;
  groups: number;
  orgUnits: number;
}

export const ownsNothing = (counts: OwnedObjectCounts) =>
  counts.users === 0 && counts.groups === 0 && counts.orgUnits === 0;

export async function ownedObjectCounts(
  tx: TenantClient,
  sourceId: string,
): Promise<OwnedObjectCounts> {
  return {
    users: await tx.user.count({ where: { sourceId } }),
    groups: await tx.group.count({ where: { sourceId } }),
    orgUnits: await tx.orgUnit.count({ where: { sourceId } }),
  };
}

/** Thrown when a source still owns directory rows and the caller has not said what should happen to them. */
export class SourceOwnsObjectsError extends Error {
  constructor(readonly counts: OwnedObjectCounts) {
    super(
      `this source still owns ${counts.users} user(s), ${counts.groups} ` +
        `group(s) and ${counts.orgUnits} organizational unit(s); deleting it ` +
        `deactivates them and detaches them from any source`,
    );
    this.name = 'SourceOwnsObjectsError';
  }
}

/**
 * Removes a source, and says what happens to the directory rows it owned.
 *
 * The rows are **deactivated and detached**, never deleted. This subsystem
 * deletes no directory object anywhere else — a group that vanishes from the
 * source is deactivated because deleting it would silently revoke access from
 * everyone in it — and a source being removed is a weaker signal than a person
 * leaving, not a stronger one.
 *
 * Detaching alone would be worse than either. It leaves accounts that look
 * ordinary and locally managed, but that no directory keeps current: a leaver
 * in that directory would never again be deactivated here. Deactivating says
 * what actually happened, is reversible by hand, and leaves the collision rule
 * intact — a future source matching one of these accounts by correlation value
 * reports a conflict rather than adopting it, which is exactly what the spec
 * asks for.
 *
 * Because that revokes real access, it is refused unless the caller confirms
 * it, in the same shape as the run guard: the counts come back on the error so
 * an administrator sees the size of what they are about to do.
 *
 * Attribute mappings, runs and changes cascade with the row. They describe the
 * source itself and mean nothing without it, unlike the accounts, which stay.
 *
 * ## The transaction budget
 *
 * The caller runs all of this in one `withTenant`, which is
 * `prisma.$transaction(fn)` on Prisma's default five-second budget. That is
 * deliberate — the deactivation, the detach and the audit event have to commit
 * together, or a half-deleted source leaves accounts detached from a source
 * that still exists — and it is safe in a way the LDAP read never was: these
 * are five index-driven bulk `updateMany`s against `sourceId`, no network I/O,
 * nothing waiting on a third party.
 *
 * It is not unbounded, though. A source owning tens of thousands of rows could
 * exceed the budget and abort with P2028, and the delete then has no recourse
 * through this function: retrying re-runs the same statements against the same
 * volume. If that happens, raise the budget for this call specifically —
 * `prisma.$transaction(fn, { timeout })` — rather than splitting the phases
 * apart, because the atomicity is the point. Splitting it to fit is how the
 * accounts end up detached from a source that was never removed.
 */
export async function deleteSource(
  tx: TenantClient,
  id: string,
  opts: { confirm?: boolean } = {},
): Promise<OwnedObjectCounts | null> {
  const existing = await tx.directorySource.findUnique({ where: { id } });
  if (!existing) return null;

  const counts = await ownedObjectCounts(tx, id);
  if (!ownsNothing(counts) && !opts.confirm) {
    throw new SourceOwnsObjectsError(counts);
  }

  const reason = `Directory source "${existing.name}" was removed`;

  await tx.user.updateMany({
    where: { sourceId: id, status: 'active' },
    data: { status: 'inactive', statusReason: reason },
  });
  await tx.group.updateMany({
    where: { sourceId: id, status: 'active' },
    data: { status: 'inactive', statusReason: reason },
  });

  // Detaching is what the foreign key's ON DELETE RESTRICT forces, and it is
  // also what makes these rows honest: an anchor that names a source which no
  // longer exists identifies nothing. Org units have no status column, so
  // detaching is all they get — the spec leaves a vanished unit alone for the
  // same reason, since units carry scoped role assignments.
  const detach = { sourceId: null, sourceAnchor: null };
  await tx.user.updateMany({ where: { sourceId: id }, data: detach });
  await tx.group.updateMany({ where: { sourceId: id }, data: detach });
  await tx.orgUnit.updateMany({ where: { sourceId: id }, data: detach });

  // The bind password goes with the source that used it. A credential nothing
  // can reach is a credential nobody is watching.
  await deleteSecret(tx, existing.secretName);

  await tx.directorySource.delete({ where: { id } });

  return counts;
}

export async function listSources(tx: TenantClient) {
  return tx.directorySource.findMany({ orderBy: { name: 'asc' } });
}

export async function findSource(tx: TenantClient, id: string) {
  return tx.directorySource.findUnique({ where: { id } });
}

/**
 * The connection configuration with its credential attached, for a run. The
 * password is never on the row and never leaves this function's caller.
 */
export async function sourceWithPassword(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
): Promise<(LdapConfig & { bindPassword: string }) | null> {
  const source = await tx.directorySource.findUnique({ where: { id } });
  if (!source) return null;

  const bindPassword = await getSecret(tx, provider, source.secretName);
  if (bindPassword === null) return null;

  return { ...ldapConfigSchema.parse(source.config), bindPassword };
}

export async function setMappings(
  tx: TenantClient,
  sourceId: string,
  rules: MappingRule[],
): Promise<void> {
  const userCorrelation = rules.filter(
    (r) => r.objectType === 'user' && r.isCorrelation,
  );
  if (userCorrelation.length !== 1) {
    throw new Error(
      'exactly one user mapping must be marked as the correlation key',
    );
  }

  // Rejected at configuration time, which is the only point at which anyone
  // is looking. A mapping onto `status` would let directory content
  // deactivate accounts through `update_user` — a change type the guard does
  // not count — and one onto `sourceId` or `sourceAnchor` would let this
  // source adopt rows it does not own. apply.ts refuses the same fields
  // again, so a mapping stored before this check cannot slip through.
  for (const objectType of ['user', 'group', 'orgUnit'] as const) {
    const rejected = unassignableFields(
      objectType,
      rules.filter((r) => r.objectType === objectType).map((r) => r.targetField),
    );
    if (rejected.length > 0) {
      throw new Error(
        `a ${objectType} mapping may not write ${rejected.join(', ')}; ` +
          `assignable ${objectType} fields are ` +
          `${ASSIGNABLE_FIELDS[objectType].join(', ')}`,
      );
    }
  }

  const tenantId = await currentTenant(tx);
  await tx.attributeMapping.deleteMany({ where: { sourceId } });
  await tx.attributeMapping.createMany({
    data: rules.map((r) => ({ tenantId, sourceId, ...r })),
  });
}

export async function mappingsFor(
  tx: TenantClient,
  sourceId: string,
): Promise<MappingRule[]> {
  const rows = await tx.attributeMapping.findMany({ where: { sourceId } });
  return rows.map((r) => ({
    objectType: r.objectType as MappingRule['objectType'],
    sourceAttribute: r.sourceAttribute,
    targetField: r.targetField,
    transform: r.transform as MappingRule['transform'],
    isCorrelation: r.isCorrelation,
  }));
}
