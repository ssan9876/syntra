import { withTenant, type TenantClient } from '@syntra/db';
import {
  adTargetConfigSchema,
  adTargetConnector,
  type AdTargetConfig,
  type ConnectionResult,
} from '@syntra/connectors';
import { z } from 'zod';
import {
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  conditionBoundsProblem,
  cronExpression,
} from '@syntra/contracts';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { deleteSecret, getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { conditionSchema, type Condition } from './condition.js';
import { applyTargetSchedule, removeTargetSchedule } from './jobs.js';
import type { GuardThresholds } from './guard.js';
import type { LadderSettings } from './types.js';

const secretNameFor = (targetId: string) => `target/${targetId}/bind`;

/**
 * Named errors rather than `findUniqueOrThrow`.
 *
 * Prisma's P2025 reads "An operation failed because it depends on one or more
 * records that were required but not found" and names neither the table nor
 * the id — so it is indistinguishable from the foreign-key violation that
 * happens two statements later when the check is dropped, and a test asserting
 * `rejects.toThrow()` cannot tell the check from its absence. That is the
 * "fixture cannot distinguish pass from fail" shape, moved into the error.
 */
export class TargetNotFoundError extends Error {
  constructor(readonly targetId: string) {
    super(`no such target system: ${targetId}`);
    this.name = 'TargetNotFoundError';
  }
}

export class BusinessRuleNotFoundError extends Error {
  constructor(readonly ruleId: string) {
    super(`no such business rule: ${ruleId}`);
    this.name = 'BusinessRuleNotFoundError';
  }
}

/**
 * A pairing that names a directory source this tenant does not have.
 *
 * `pairedDirectorySourceId` used to be validated as "is a uuid" and nothing
 * more, and every reader of it — `claimSyntraUsers`, `enqueuePairedSync`, the
 * run summary's `pairedDirectorySource` flag — asks only whether it is
 * non-null. A well-formed uuid that names nothing therefore passed the gate
 * that exists to fail closed, claimed zero logins, reported the same summary a
 * healthy target reports, and left every leaver on the target holding their
 * Syntra login. Non-null and valid are different questions.
 *
 * The foreign key added in 20260822000000_target_paired_source_fk is the
 * backstop; this read is what turns a mistyped id into a message. It is also
 * the only half of the pair that can enforce the *tenant*: the key references
 * `DirectorySource(id)` alone, so another tenant's source satisfies it, while
 * this read runs under the bound tenant's row-level security and cannot see
 * one. The distinction is not a refinement — a cross-tenant pairing is a target
 * whose inward status propagation reads somebody else's directory.
 */
export class PairedDirectorySourceNotFoundError extends Error {
  constructor(readonly sourceId: string) {
    super(`no such directory source to pair with: ${sourceId}`);
    this.name = 'PairedDirectorySourceNotFoundError';
  }
}

export class DriftFindingNotFoundError extends Error {
  constructor(readonly findingId: string) {
    super(`no such drift finding: ${findingId}`);
    this.name = 'DriftFindingNotFoundError';
  }
}

/**
 * A rule edited through the wrong target's endpoint, or naming an entitlement
 * another target owns.
 *
 * Both are the caller naming something that exists and is not theirs to name
 * here, which is a 400 and not a 500. They were plain `Error`s, and a plain
 * `Error` out of a service reaches the API's error handler as an unhandled
 * fault: the response is a bare 500 with no detail, so an administrator who
 * picked a group from the wrong list is told the server broke. The message
 * is unchanged, so every existing test that matches on it still matches.
 */
export class ProvisionOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionOwnershipError';
  }
}

/**
 * The only `type` this service can honestly store.
 *
 * `TargetSystem.type` is a column of type text so that a second connector
 * family needs no migration, and that is still true. But everything below
 * parses the configuration with `adTargetConfigSchema` and tests it with
 * `adTargetConnector`, so a row saying `okta` with an Active Directory
 * configuration on it describes a target nothing in this package can read.
 * The check moves when a second connector arrives; until then the column and
 * the code agree.
 */
const TARGET_TYPES = ['activeDirectory'] as const;

const ENFORCEMENT_MODES = ['additive', 'authoritative'] as const;
export type EnforcementModeInput = (typeof ENFORCEMENT_MODES)[number];

export interface CreateTargetInput {
  name: string;
  type?: string;
  config: unknown;
  bindPassword: string;
  pairedDirectorySourceId?: string | null;
  schedule?: string | null;
  autoApply?: boolean;
  enabled?: boolean;
  enforcementMode?: 'additive' | 'authoritative';
}

/**
 * The scalar half of a create, validated rather than trusted.
 *
 * The route layer parses its own request body, but this function is exported
 * from `@syntra/core` and is reachable from a job, a script or a test with
 * whatever a caller assembled. `name` is `@@unique([tenantId, name])` and a
 * blank one is a row nobody can name; `enforcementMode` reaching the column
 * misspelled is worse than a rejection, because `reconcile.ts` compares it
 * against the literal `'authoritative'` and every other string silently
 * behaves as `additive` — the mode an administrator did not choose, displayed
 * back to them as the mode they typed.
 */
const createScalarsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(TARGET_TYPES).default('activeDirectory'),
  bindPassword: z.string().min(1),
  pairedDirectorySourceId: z.string().uuid().nullable().optional(),
  /**
   * Directory Sync's validator, imported rather than restated.
   *
   * `z.string().max(200)` accepted any string at all, so a malformed cron
   * expression committed to the row and audited as a success, and only then
   * threw out of `applyTargetSchedule` -- after `withTenant` had returned,
   * so on a create the target and its vault entry exist, the caller gets a
   * 500 and never learns the id, and the retry hits
   * `@@unique([tenantId, name])`. Parsed exactly the way pg-boss parses it
   * (same library, same `tz`, same `strict`), so this accepts precisely what
   * the scheduler accepts. The bound drops from 200 to the shared 128, which
   * no cron expression comes near.
   */
  schedule: cronExpression.nullable().optional(),
  autoApply: z.boolean().optional(),
  enabled: z.boolean().optional(),
  enforcementMode: z.enum(ENFORCEMENT_MODES).optional(),
});

/**
 * The seven threshold columns, named explicitly.
 *
 * `updateTarget` picks from this rather than spreading `input.thresholds` into
 * Prisma's `data`: a spread makes any extra key a Prisma error at run time
 * rather than a validation failure, and it turns the shape of the request body
 * into the shape of the write. Seven names in one place is also what makes the
 * correspondence with `GuardThresholds` and `thresholdsSchema` checkable by
 * reading.
 */
const THRESHOLD_FIELDS = [
  'createAccountThresholdPercent',
  'disableAccountThresholdPercent',
  'archiveAccountThresholdPercent',
  'revokeEntitlementThresholdPercent',
  'deactivateSyntraUserThresholdPercent',
  'perEntitlementThresholdPercent',
  'personPopulationDropPercent',
] as const;

/**
 * The seven thresholds, as percentages.
 *
 * `target_system_thresholds_are_percent` says the same thing in the database,
 * and that constraint is the backstop rather than the check: a violated CHECK
 * is a 500 with a constraint name in it, and this is the message. It matters
 * more here than it looks, because Ruling P25 made a threshold that is not a
 * comparable percentage a **non-confirmable refusal** in the guard — so a
 * value that slips past this line does not misbehave quietly, it blocks every
 * run against that target until somebody edits the row by hand.
 *
 * The keys are `THRESHOLD_FIELDS`, checked against `GuardThresholds` below, so
 * the three lists cannot drift apart without the compiler saying so.
 */
export const provisionThresholdsSchema = z
  .object(
    Object.fromEntries(
      THRESHOLD_FIELDS.map((field) => [
        field,
        z.number().int().min(0).max(100).optional(),
      ]),
    ) as {
      [K in (typeof THRESHOLD_FIELDS)[number]]: z.ZodOptional<z.ZodNumber>;
    },
  )
  .strict();

/**
 * `THRESHOLD_FIELDS` is exactly the key set of `GuardThresholds`, checked at
 * compile time rather than by reading two lists side by side.
 *
 * Ruling P21's lesson applies in reverse here: an annotation that merely
 * *declares* a correspondence checks nothing, so this is a mutual
 * assignability assertion between the two key sets, which does. Add a
 * threshold to the guard and forget this file and it fails here, rather than
 * at the far end of a threshold an administrator can set and nothing reads.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _thresholdFieldsMatchGuard: MutuallyAssignable<
  (typeof THRESHOLD_FIELDS)[number],
  keyof GuardThresholds
> = true;
void _thresholdFieldsMatchGuard;

function pickThresholds(
  thresholds: Partial<GuardThresholds> | undefined,
): Partial<Record<(typeof THRESHOLD_FIELDS)[number], number>> {
  if (thresholds === undefined) return {};
  const parsed = provisionThresholdsSchema.parse(thresholds);
  const picked: Partial<Record<(typeof THRESHOLD_FIELDS)[number], number>> = {};
  for (const field of THRESHOLD_FIELDS) {
    const value = parsed[field];
    if (value !== undefined) picked[field] = value;
  }
  return picked;
}

/** The ladder and the three run settings that have no CHECK behind them. */
const ladderInputSchema = z
  .object({
    entitlementRevocationDelayDays: z.number().int().min(0).max(3650).optional(),
    disableGraceDays: z.number().int().min(0).max(3650).optional(),
    archiveAfterDays: z.number().int().min(0).max(3650).nullable().optional(),
    reenableWithoutConfirmationDays: z.number().int().min(0).max(3650).optional(),
    renameEnabled: z.boolean().optional(),
  })
  .strict();

const runSettingsSchema = z
  .object({
    preHireDays: z.number().int().min(0).max(365).optional(),
    // Zero attempts is an action that is never tried and never fails, which
    // reads on the review screen as a run that did nothing for no reason.
    maxAttempts: z.number().int().min(1).max(10).optional(),
    // Zero concurrency is a run that makes no progress; an unbounded one is a
    // directory controller taking the whole plan at once.
    concurrency: z.number().int().min(1).max(32).optional(),
  })
  .strict();

/**
 * Validates the ladder before it reaches the database.
 *
 * The CHECK constraint is the backstop; this is the message. An account whose
 * entitlements were stripped a week before it was disabled belongs to somebody
 * who is still employed as far as the directory is concerned and cannot do
 * anything.
 */
function assertLadder(ladder: {
  entitlementRevocationDelayDays: number;
  disableGraceDays: number;
  archiveAfterDays: number | null;
}): void {
  if (ladder.entitlementRevocationDelayDays > ladder.disableGraceDays) {
    throw new Error(
      'entitlement revocations cannot be delayed past the disable: that describes an account whose holder is still employed as far as the directory is concerned and cannot do anything',
    );
  }
  if (
    ladder.archiveAfterDays !== null &&
    ladder.archiveAfterDays <= ladder.disableGraceDays
  ) {
    throw new Error(
      'the archive must fall strictly after the disable: archiving moves the object and strips its remaining entitlements',
    );
  }
}

/**
 * Refuses a pairing that names no directory source this tenant can see.
 *
 * Run inside the writing transaction, so what is checked is what is written
 * against rather than what was true a moment earlier; the foreign key catches
 * the source deleted in the remaining gap. `undefined` means the caller said
 * nothing about the pairing and `null` means they cleared it — neither names
 * anything, so neither is read.
 */
async function assertPairedSourceExists(
  tx: TenantClient,
  sourceId: string | null | undefined,
): Promise<void> {
  if (sourceId === undefined || sourceId === null) return;
  const source = await tx.directorySource.findUnique({ where: { id: sourceId } });
  if (!source) throw new PairedDirectorySourceNotFoundError(sourceId);
}

export async function createTarget(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  input: CreateTargetInput,
  scheduler?: Scheduler,
): Promise<{ id: string }> {
  // Parsed outside the transaction. A schema failure is a validation error,
  // not a rolled-back write.
  const config = adTargetConfigSchema.parse(input.config);
  const scalars = createScalarsSchema.parse(input);

  const created = await withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    await assertPairedSourceExists(tx, scalars.pairedDirectorySourceId);
    const target = await tx.targetSystem.create({
      data: {
        tenantId: bound,
        name: scalars.name,
        type: scalars.type,
        config,
        // Replaced immediately below, once the id exists.
        secretName: 'pending',
        pairedDirectorySourceId: scalars.pairedDirectorySourceId ?? null,
        schedule: scalars.schedule ?? null,
        autoApply: scalars.autoApply ?? false,
        enabled: scalars.enabled ?? true,
        enforcementMode: scalars.enforcementMode ?? 'additive',
      },
    });

    const secretName = secretNameFor(target.id);
    await putSecret(tx, provider, secretName, scalars.bindPassword);
    await tx.targetSystem.update({ where: { id: target.id }, data: { secretName } });

    // The audit event and the mutation in one transaction.
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.create',
      targetType: 'TargetSystem',
      targetId: target.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        name: scalars.name,
        url: config.url,
        tlsMode: config.tlsMode,
        enforcementMode: scalars.enforcementMode ?? 'additive',
      },
    });

    return { id: target.id };
  });

  // Reconciled OUTSIDE the transaction. pg-boss writes to its own tables on
  // its own connection: a schedule write inside this transaction would neither
  // roll back with it nor be covered by it. Reconciled from the PARSED
  // scalars, which are exactly what the row above was written from, and never
  // from `input`.
  if (scheduler) {
    await applyTargetSchedule(scheduler, tenantId, {
      id: created.id,
      schedule: scalars.schedule ?? null,
      enabled: scalars.enabled ?? true,
    });
  }
  return created;
}

export interface UpdateTargetInput extends Partial<CreateTargetInput> {
  thresholds?: Partial<GuardThresholds>;
  ladder?: Partial<LadderSettings>;
  preHireDays?: number;
  maxAttempts?: number;
  concurrency?: number;
}

export async function updateTarget(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  targetId: string,
  input: UpdateTargetInput,
  scheduler?: Scheduler,
): Promise<void> {
  const config =
    input.config === undefined ? undefined : adTargetConfigSchema.parse(input.config);
  // Every scalar is optional on an update, so the create schema is reused
  // partially rather than restated. `.partial()` keeps the same bounds.
  const scalars = createScalarsSchema.partial().strict().parse({
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.bindPassword === undefined ? {} : { bindPassword: input.bindPassword }),
    ...(input.pairedDirectorySourceId === undefined
      ? {}
      : { pairedDirectorySourceId: input.pairedDirectorySourceId }),
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
    ...(input.autoApply === undefined ? {} : { autoApply: input.autoApply }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.enforcementMode === undefined
      ? {}
      : { enforcementMode: input.enforcementMode }),
  });
  const ladderInput = ladderInputSchema.parse(input.ladder ?? {});
  const runSettings = runSettingsSchema.parse({
    ...(input.preHireDays === undefined ? {} : { preHireDays: input.preHireDays }),
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
  });
  const thresholds = pickThresholds(input.thresholds);

  const after = await withTenant(tenantId, async (tx) => {
    const before = await tx.targetSystem.findUnique({ where: { id: targetId } });
    if (!before) throw new TargetNotFoundError(targetId);
    await assertPairedSourceExists(tx, scalars.pairedDirectorySourceId);

    const ladder = {
      entitlementRevocationDelayDays:
        ladderInput.entitlementRevocationDelayDays ??
        before.entitlementRevocationDelayDays,
      disableGraceDays: ladderInput.disableGraceDays ?? before.disableGraceDays,
      archiveAfterDays:
        ladderInput.archiveAfterDays === undefined
          ? before.archiveAfterDays
          : ladderInput.archiveAfterDays,
    };
    assertLadder(ladder);

    await tx.targetSystem.update({
      where: { id: targetId },
      data: {
        ...(scalars.name === undefined ? {} : { name: scalars.name }),
        ...(scalars.type === undefined ? {} : { type: scalars.type }),
        ...(config === undefined ? {} : { config }),
        ...(scalars.schedule === undefined ? {} : { schedule: scalars.schedule }),
        ...(scalars.autoApply === undefined ? {} : { autoApply: scalars.autoApply }),
        ...(scalars.enabled === undefined ? {} : { enabled: scalars.enabled }),
        ...(scalars.enforcementMode === undefined
          ? {}
          : { enforcementMode: scalars.enforcementMode }),
        ...(scalars.pairedDirectorySourceId === undefined
          ? {}
          : { pairedDirectorySourceId: scalars.pairedDirectorySourceId }),
        ...(runSettings.preHireDays === undefined
          ? {}
          : { preHireDays: runSettings.preHireDays }),
        ...(runSettings.maxAttempts === undefined
          ? {}
          : { maxAttempts: runSettings.maxAttempts }),
        ...(runSettings.concurrency === undefined
          ? {}
          : { concurrency: runSettings.concurrency }),
        ...(ladderInput.reenableWithoutConfirmationDays === undefined
          ? {}
          : {
              reenableWithoutConfirmationDays:
                ladderInput.reenableWithoutConfirmationDays,
            }),
        ...(ladderInput.renameEnabled === undefined
          ? {}
          : { renameEnabled: ladderInput.renameEnabled }),
        entitlementRevocationDelayDays: ladder.entitlementRevocationDelayDays,
        disableGraceDays: ladder.disableGraceDays,
        archiveAfterDays: ladder.archiveAfterDays,
        // Seven named columns, never a spread of whatever arrived.
        ...thresholds,
      },
    });

    if (scalars.bindPassword !== undefined) {
      // `before.secretName`, NOT `secretNameFor(targetId)`. The row names the
      // vault entry, `targetWithCredential` reads the entry the row names, and
      // a rotation that writes to a *derived* name would leave the row still
      // pointing at the old ciphertext: the write succeeds, the audit event
      // says `credentialReplaced: true`, and the target goes on binding with
      // the credential the administrator just retired. The two must be the
      // same string by construction rather than by both being computed the
      // same way.
      await putSecret(tx, provider, before.secretName, scalars.bindPassword);
    }

    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.update',
      targetType: 'TargetSystem',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        ...(scalars.enforcementMode === undefined
          ? {}
          : {
              enforcementMode: {
                from: before.enforcementMode,
                to: scalars.enforcementMode,
              },
            }),
        ...(input.thresholds === undefined ? {} : { thresholds }),
        ladder,
        credentialReplaced: scalars.bindPassword !== undefined,
      },
    });

    // Read AFTER the update, and from the row rather than from the request
    // body: an update that only sets `enabled: false` says nothing about the
    // cron expression, and one that only clears the cron expression says
    // nothing about `enabled`. Reconciling from the input alone leaves the old
    // schedule firing at a target the administrator just stopped.
    return tx.targetSystem.findUniqueOrThrow({
      where: { id: targetId },
      select: { schedule: true, enabled: true },
    });
  });

  // Outside the transaction, for the reason `createTarget` records.
  if (scheduler) {
    await applyTargetSchedule(scheduler, tenantId, {
      id: targetId,
      schedule: after.schedule,
      enabled: after.enabled,
    });
  }
}

export async function deleteTarget(
  tenantId: string,
  actorUserId: string | null,
  targetId: string,
  confirm: boolean,
  scheduler?: Scheduler,
): Promise<{ ok: boolean; counts?: Record<string, number> }> {
  const result = await withTenant(tenantId, async (tx) => {
    // Read before the counts, so a request naming a target that is not there
    // fails as "no such target" rather than reporting three convincing zeroes
    // and, on `confirm: true`, a Prisma P2025 from two statements further on.
    const target = await tx.targetSystem.findUnique({ where: { id: targetId } });
    if (!target) throw new TargetNotFoundError(targetId);

    const counts = {
      accounts: await tx.targetAccount.count({ where: { targetSystemId: targetId } }),
      rules: await tx.businessRule.count({ where: { targetSystemId: targetId } }),
      entitlements: await tx.entitlement.count({ where: { targetSystemId: targetId } }),
    };
    if (!confirm) return { ok: false, counts };

    // The bind credential goes with the target that used it, as
    // `deleteSource` does for a directory source. A vault entry nothing can
    // reach any more is a credential nobody is watching, and the name is
    // derived from an id that will never be issued again, so nothing will ever
    // overwrite it either.
    await deleteSecret(tx, target.secretName);
    await tx.targetSystem.delete({ where: { id: targetId } });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.target.delete',
      targetType: 'TargetSystem',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: counts,
    });
    return { ok: true };
  });

  // Only when the delete actually happened: `confirm: false` reports the
  // counts and deletes nothing, and unscheduling there would stop a target
  // that still exists, from a request that was a question rather than an
  // instruction. A schedule left behind after a real delete fires for ever at
  // a target that is not there, and the handler's `findUnique` returns null
  // every time -- a job failing silently on a timer nobody remembers setting.
  if (result.ok && scheduler) {
    await removeTargetSchedule(scheduler, tenantId, targetId);
  }
  return result;
}

/**
 * The configuration plus the bind credential, for the run to use *outside* any
 * transaction. Returns plain data, deliberately not a `tx` handle: nothing
 * downstream may hold one open across a target read.
 *
 * The stored configuration is re-parsed rather than cast. A cast asserts that
 * a column written by some earlier version of this code still satisfies the
 * schema this one compiled against, and asserting it is not the same as it
 * being true — a config missing a key the schema has since added would reach
 * the connector as `undefined` and be discovered as a malformed LDAP request
 * against a live directory. Parsing also resolves the defaults, so callers see
 * the same values the connector will use.
 */
export async function targetWithCredential(
  tx: TenantClient,
  provider: MasterKeyProvider,
  targetId: string,
): Promise<(AdTargetConfig & { bindPassword: string }) | null> {
  const target = await tx.targetSystem.findUnique({ where: { id: targetId } });
  if (!target) return null;
  const bindPassword = await getSecret(tx, provider, target.secretName);
  if (bindPassword === null) return null;
  return {
    ...adTargetConfigSchema.parse(target.config),
    bindPassword,
  };
}

/**
 * Tests a configuration, optionally borrowing a saved target's credential.
 *
 * Borrowing requires the transport — URL, TLS mode and certificate setting —
 * to match the saved target, so a test cannot be pointed at an
 * attacker-controlled socket to harvest the credential. This is the rule
 * Directory Sync arrived at after a security review, adopted here at the
 * start rather than after.
 */
export async function testTargetConfiguration(
  tenantId: string,
  provider: MasterKeyProvider,
  input: { config: unknown; bindPassword?: string; borrowFromTargetId?: string },
): Promise<ConnectionResult> {
  const config = adTargetConfigSchema.parse(input.config);

  let bindPassword = input.bindPassword;
  if (bindPassword === undefined) {
    if (input.borrowFromTargetId === undefined) {
      return { ok: false, message: 'no credential supplied and none to borrow' };
    }
    const borrowFromTargetId = input.borrowFromTargetId;
    const saved = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.findUnique({
        where: { id: borrowFromTargetId },
      });
      if (!target) return null;
      // Parsed, not cast, and for the reason this comparison exists: the
      // saved side must be resolved the same way the requested side is, or
      // `rejectUnauthorized` absent from an older row compares unequal to the
      // `true` the schema fills in, and every borrow is refused for a
      // difference that is not one.
      const savedConfig = adTargetConfigSchema.parse(target.config);
      if (
        savedConfig.url.trim() !== config.url.trim() ||
        savedConfig.tlsMode !== config.tlsMode ||
        savedConfig.rejectUnauthorized !== config.rejectUnauthorized
      ) {
        return 'mismatch' as const;
      }
      return getSecret(tx, provider, target.secretName);
    });
    if (saved === 'mismatch') {
      return {
        ok: false,
        message:
          'a saved credential can only be borrowed for the transport it was saved against: the URL, TLS mode and certificate setting must all match',
      };
    }
    if (saved === null) return { ok: false, message: 'no saved credential' };
    bindPassword = saved;
  }

  // Outside any transaction: this is a network call.
  return adTargetConnector.test({ ...config, bindPassword });
}

/**
 * Attributes an account profile may never write, matched case-insensitively.
 *
 * `setMappings` in `sync/source-service.ts` refuses the same class of thing
 * for the same reason, and the reason is worth restating: `update_account`
 * carries the complete managed attribute set and the connector writes every
 * entry of it as a `replace`, and `update_account` is deliberately **absent**
 * from `GUARDED_ACTION_TYPES`. So an attribute template naming one of these
 * turns a profile edit into a capability the guard does not count, the ladder
 * does not sequence and the review screen does not describe.
 *
 * - `userAccountControl` — the disable bit. A profile could disable or enable
 *   every account it manages, bypassing the grace ladder entirely.
 * - `unicodePwd`, `userPassword`, `pwdLastSet` — the credential, outside the
 *   vault, the initial-password policy and the delivery choice.
 * - `member`, `memberOf`, `primaryGroupID` — group membership, outside the
 *   entitlement catalog, outside the remit and outside the per-entitlement
 *   revocation axis.
 * - `distinguishedName` — the connector reads this one as a **move**
 *   (`modifyDN`), so a template setting it relocates every managed account
 *   without a `rename_account` action and without its confirmation.
 * - `objectClass`, `objectCategory` — what the object is.
 * - `objectGUID`, `objectSid` — the anchor Provision correlates on.
 * - `sAMAccountName` — the correlation key, owned by
 *   `correlationKeyTemplate` and the rename ladder.
 * - `ntSecurityDescriptor` — the object's ACL.
 */
export const UNWRITABLE_ACCOUNT_ATTRIBUTES = [
  'userAccountControl',
  'unicodePwd',
  'userPassword',
  'pwdLastSet',
  'member',
  'memberOf',
  'primaryGroupID',
  'distinguishedName',
  'objectClass',
  'objectCategory',
  'objectGUID',
  'objectSid',
  'sAMAccountName',
  'ntSecurityDescriptor',
] as const;

const unwritableAttributes = new Set<string>(
  UNWRITABLE_ACCOUNT_ATTRIBUTES.map((a) => a.toLowerCase()),
);

/**
 * The initial password policy, as a shape rather than a bag.
 *
 * `z.record(z.unknown())` stores whatever arrives, and Task 14 reads the
 * column back with a cast — so `{ length: 2 }` and `{ lenght: 24 }` are both
 * saved without complaint and both produce a password nobody intended. The
 * five keys are the ones `generateInitialPassword` reads; `.strict()` is what
 * turns the misspelling into a message instead of a silent default.
 */
export const initialPasswordPolicySchema = z
  .object({
    length: z.number().int().min(12).max(256).optional(),
    requireUpper: z.boolean().optional(),
    requireLower: z.boolean().optional(),
    requireDigit: z.boolean().optional(),
    requireSymbol: z.boolean().optional(),
  })
  .strict();

/** RFC 4512 `descr`: a letter, then letters, digits and hyphens. */
const LDAP_ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

const attributeTemplatesSchema = z
  .record(
    z.string().max(64).regex(LDAP_ATTRIBUTE_NAME, {
      message: 'not an LDAP attribute name',
    }),
    /**
     * Non-blank, which every other template field on this schema already is.
     *
     * A blank template renders `{ ok: true, value: '' }` — no reference is
     * missing, because there is no reference — and `desiredState` writes `['']`
     * into the desired attributes. Active Directory refuses a zero-length
     * value, so the `update_account` fails; a failed action does not update
     * `lastAppliedAttributes`, so the next run computes the same difference and
     * proposes the same failing write, for that person and every other person
     * the profile applies to, on every run, for ever. An attribute a profile
     * does not want written is one the profile does not name.
     */
    z
      .string()
      .max(1024)
      .refine((template) => template.trim() !== '', {
        message:
          'an attribute template may not be blank: it would write a zero-length value, which the directory refuses on every run',
      }),
  )
  .superRefine((templates, ctx) => {
    if (Object.keys(templates).length > 64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an account profile may set at most 64 attributes',
      });
    }
    for (const name of Object.keys(templates)) {
      if (unwritableAttributes.has(name.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message:
            `an account profile may not write ${name}: it is written by the ` +
            `provisioning actions themselves, which the guard counts and the ` +
            `ladder sequences, and update_account is neither`,
        });
      }
    }
  });

export const accountProfileSchema = z.object({
  // Bounded, per the carry-forward from Task 6: this is the profile write
  // boundary, and `correlationKeyTemplate` and `containerTemplate` are
  // rendered on every person in the tenant on every run.
  correlationKeyTemplate: z.string().min(1).max(1024),
  uniquenessStrategy: z.literal('numericSuffix').default('numericSuffix'),
  maxUniquenessAttempts: z.number().int().positive().max(200),
  containerTemplate: z.string().min(1).max(1024),
  // Required: a template that resolves to nothing must land somewhere known,
  // and Provision does not create organizational units in somebody else's
  // domain.
  fallbackContainer: z.string().min(1).max(1024),
  attributeTemplates: z.record(z.string()).pipe(attributeTemplatesSchema),
  // `z.record(z.unknown())` on the way in so a caller holding an open bag —
  // a route body, a JSON column — still typechecks; the strict shape on the
  // way out is what actually decides.
  initialPasswordPolicy: z.record(z.unknown()).pipe(initialPasswordPolicySchema),
  initialPasswordDelivery: z.enum(['manager', 'personalEmail', 'vaultOnly']),
});
export type AccountProfileInput = z.input<typeof accountProfileSchema>;

export async function upsertAccountProfile(
  tenantId: string,
  actorUserId: string | null,
  targetId: string,
  input: AccountProfileInput,
): Promise<void> {
  const profile = accountProfileSchema.parse(input);
  await withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);
    // Named, so a profile for a target that is not there is a message rather
    // than a foreign-key violation two statements later.
    const target = await tx.targetSystem.findUnique({ where: { id: targetId } });
    if (!target) throw new TargetNotFoundError(targetId);

    // One statement rather than find-then-branch. `targetSystemId` is
    // `@unique` — the Task 1 deviation — so it is a valid unique selector, and
    // two concurrent saves of the same profile resolve in the database instead
    // of racing between the read and the write.
    await tx.accountProfile.upsert({
      where: { targetSystemId: targetId },
      create: { tenantId: bound, targetSystemId: targetId, ...profile },
      update: profile,
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'provision.profile.upsert',
      // The TargetSystem, not the AccountProfile: `targetId` below is the
      // target's id, and a `targetType` naming a different table than the id
      // belongs to is an audit row nothing can join. The profile is one per
      // target, so the target identifies it.
      targetType: 'TargetSystem',
      targetId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        profile: 'AccountProfile',
        correlationKeyTemplate: profile.correlationKeyTemplate,
        containerTemplate: profile.containerTemplate,
        initialPasswordDelivery: profile.initialPasswordDelivery,
      },
    });
  });
}

/**
 * How deeply a stored condition may nest, and how many nodes it may hold.
 *
 * `conditionSchema` is `z.lazy` and recurses once per level with no cap of its
 * own — Task 5 flagged that and both Tasks 6 and 7 correctly refused it as out
 * of scope, being pure modules with no write boundary. This is the write
 * boundary, so it is enforced here.
 *
 * The numbers and the walk itself now live in `@syntra/contracts`, and are
 * re-exported rather than restated. `conditionRequestSchema` at the HTTP edge
 * is a second `z.lazy` that is parsed BEFORE anything in this package runs, so
 * the cap has to exist there too — and two copies of a cap that must agree is
 * a cap that eventually does not, silently and in the dangerous direction.
 * `@syntra/core` already depends on `@syntra/contracts`, so there is exactly
 * one definition and both boundaries share it.
 *
 * It fails closed either way: a 20,000-deep condition throws a `RangeError`
 * rather than parsing into something dangerous. What it costs is a stack
 * unwind per request, on a body a client chooses the size of, which is a cheap
 * denial of service against the one endpoint an administrator uses to fix
 * rules.
 */
export { MAX_CONDITION_DEPTH, MAX_CONDITION_NODES };

/**
 * The bounded condition schema.
 *
 * `z.preprocess` runs **before** the wrapped schema, and `fatal: true` stops
 * the pipeline there, so an over-deep condition is refused without
 * `conditionSchema` ever being entered — verified, not assumed: the `z.lazy`
 * callback is not invoked at all on a rejected input.
 *
 * Wired into the schema rather than offered as a helper next to it. Ruling P22
 * is about exactly this: a check that is safe only when somebody remembers to
 * call it will eventually not be called, and `businessRuleSchema` is what the
 * route layer will reach for.
 *
 * The cast restores the declared input type. `z.preprocess` types its input as
 * `unknown`, which would make `BusinessRuleInput['condition']` accept anything
 * and quietly delete the compile-time checking Task 5 built for callers
 * constructing a `Condition` in TypeScript. It is a cast over the *declared
 * shape* only — the validation underneath is `conditionSchema` itself, doing
 * all of the work it always did.
 */
export const boundedConditionSchema = z.preprocess((raw, ctx) => {
  const problem = conditionBoundsProblem(raw);
  if (problem !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, fatal: true });
    return z.NEVER;
  }
  return raw;
}, conditionSchema) as unknown as z.ZodType<Condition, z.ZodTypeDef, Condition>;

export const businessRuleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  condition: boundedConditionSchema,
  grantsAccount: z.boolean(),
  enabled: z.boolean(),
  entitlementIds: z.array(z.string().uuid()).max(512),
});
export type BusinessRuleInput = z.input<typeof businessRuleSchema>;

export async function upsertBusinessRule(
  tenantId: string,
  actorUserId: string | null,
  targetId: string,
  input: BusinessRuleInput,
): Promise<{ id: string }> {
  const rule = businessRuleSchema.parse(input);
  // Deduplicated before it is counted or written. `[e, e]` would otherwise
  // fail the ownership count below with a message about a foreign target —
  // the wrong reason, for a request that names nothing wrong — and, past it,
  // violate `@@unique([ruleId, entitlementId])` on the second insert.
  const entitlementIds = [...new Set(rule.entitlementIds)];

  return withTenant(tenantId, async (tx) => {
    const bound = await currentTenant(tx);

    // The rule being edited must belong to the target it is being edited
    // through. Without this, a caller naming a rule on target A through
    // target B's endpoint passes the ownership check below — which asks about
    // B's entitlements — and then attaches B's entitlements to A's rule.
    // That is precisely the cross-target grant the check exists to refuse,
    // reached by the one route the check does not look at.
    if (rule.id !== undefined) {
      const existing = await tx.businessRule.findUnique({ where: { id: rule.id } });
      if (!existing || existing.targetSystemId !== targetId) {
        throw new ProvisionOwnershipError('this rule does not belong to this target');
      }
    }

    // An entitlement from another target would grant access somewhere this
    // rule does not describe.
    if (entitlementIds.length > 0) {
      const owned = await tx.entitlement.count({
        where: { id: { in: entitlementIds }, targetSystemId: targetId },
      });
      if (owned !== entitlementIds.length) {
        throw new ProvisionOwnershipError(
          'an entitlement named by this rule does not belong to this target',
        );
      }
    }

    const row = rule.id
      ? await tx.businessRule.update({
          where: { id: rule.id },
          data: {
            name: rule.name,
            description: rule.description ?? null,
            condition: rule.condition,
            grantsAccount: rule.grantsAccount,
            enabled: rule.enabled,
          },
        })
      : await tx.businessRule.create({
          data: {
            tenantId: bound,
            targetSystemId: targetId,
            name: rule.name,
            description: rule.description ?? null,
            condition: rule.condition,
            grantsAccount: rule.grantsAccount,
            enabled: rule.enabled,
          },
        });

    await tx.ruleEntitlement.deleteMany({ where: { ruleId: row.id } });
    for (const entitlementId of entitlementIds) {
      await tx.ruleEntitlement.create({
        data: { tenantId: bound, ruleId: row.id, entitlementId },
      });
    }

    await recordEvent(tx, {
      actorUserId,
      action: rule.id ? 'provision.rule.update' : 'provision.rule.create',
      targetType: 'BusinessRule',
      targetId: row.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        name: rule.name,
        enabled: rule.enabled,
        grantsAccount: rule.grantsAccount,
        entitlementCount: entitlementIds.length,
        condition: rule.condition,
      },
    });

    return { id: row.id };
  });
}

export async function deleteBusinessRule(
  tenantId: string,
  actorUserId: string | null,
  ruleId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const rule = await tx.businessRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new BusinessRuleNotFoundError(ruleId);
    await tx.businessRule.delete({ where: { id: ruleId } });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.rule.delete',
      targetType: 'BusinessRule',
      targetId: ruleId,
      outcome: 'success',
      sourceIp: null,
      payload: { name: rule.name, targetSystemId: rule.targetSystemId },
    });
  });
}

/**
 * Acknowledges or resolves one drift finding, and records who did it.
 *
 * **Audited, which is the whole reason this is a service and not four lines in
 * a route.** Acknowledging a finding is a person saying "this account holds
 * access Syntra never granted, and that is fine" — precisely the decision an
 * auditor needs a name against, and the only write in this package that used
 * to happen with no audit entry at all. Every other write here delegates to an
 * audited service, and the route now does too.
 *
 * The payload names the field that changed and the transition, and carries
 * neither `detail` nor `subjectAnchor`: the finding's own row holds those, and
 * the audit log is not the second place a target's object names should live.
 *
 * `findUnique` and a typed error rather than `updateMany` and a count. Row
 * Level Security makes another tenant's finding invisible, so a null here is
 * "not there" in both senses, and the route turns it into a 404 — which is
 * what the route's `updateMany` was reaching for. `update` after the read is
 * safe for the same reason the read was: both are inside one transaction.
 */
export async function acknowledgeDriftFinding(
  tenantId: string,
  actorUserId: string | null,
  findingId: string,
  status: 'acknowledged' | 'resolved',
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const finding = await tx.driftFinding.findUnique({ where: { id: findingId } });
    if (!finding) throw new DriftFindingNotFoundError(findingId);

    // Nothing changed, so nothing is recorded: an audit trail whose rows
    // include re-acknowledgements of what was already acknowledged is one
    // nobody can read the decisions out of.
    if (finding.status === status) return;

    await tx.driftFinding.update({
      where: { id: findingId },
      data: { status },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'provision.drift.acknowledge',
      targetType: 'DriftFinding',
      targetId: findingId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        targetSystemId: finding.targetSystemId,
        kind: finding.kind,
        changed: ['status'],
        status: { from: finding.status, to: status },
      },
    });
  });
}
