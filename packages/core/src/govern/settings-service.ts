import { Prisma, withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { currentTenant } from '../tenant-context.js';
import type { z } from 'zod';
import { governSettingsBody } from '@syntra/contracts';
import type { MutuallyAssignable } from './types.js';

/** Get-or-create the single row, so no caller has to know whether it exists. */
export async function governSettings(tx: TenantClient) {
  const tenantId = await currentTenant(tx);
  const existing = await tx.governSettings.findUnique({ where: { tenantId } });
  if (existing !== null) return existing;
  return tx.governSettings.create({ data: { tenantId } });
}

const PERCENT_FIELDS = [
  'batchThresholdPercent',
  'perResourceThresholdPercent',
  'personPopulationDropPercent',
  'minimumCoveragePercent',
];

/**
 * The FIFTEEN settings a `govern.manage` holder may write, and nothing else.
 *
 * Changing any threshold, freshness SLA or snapshot cadence is a PRIVILEGED,
 * AUDITED action, and the audit event carries the old value beside the new one.
 * §21 names this explicitly and gives the reason: lowering a threshold is
 * functionally the same act as confirming everything it would otherwise have
 * caught, and lengthening a cadence is functionally the same as agreeing not to
 * see things.
 *
 * `GovernSettings` also carries `lastAppliedBatchAt` and
 * `personsWithActiveContractAtLastBatch`, and the schema's own comment says
 * "they are not settings. They are the denominator the population-collapse
 * refusal compares against". With `data: input as never` and no allow-list, a
 * `PATCH /govern/settings` could write both — and setting
 * `personsWithActiveContractAtLastBatch: 0` disables §13's population-collapse
 * refusal permanently. That is §21's privileged act with no threshold visible
 * at all.
 *
 * Typed as an explicit partial rather than `Record<string, …>`, so the write
 * needs no cast: both `as never` casts here and at the route were defects by
 * Global Constraint 12's own terms.
 */
export interface GovernSettingsInput {
  /**
   * Nullable, because clearing the cadence is a real operation:
   * `applyGovernSchedules` reads `null` as "unschedule every purpose for this
   * tenant", and a settings body that could not express it would leave a
   * tenant that turned snapshots off with schedule rows nothing removes.
   */
  snapshotSchedule?: string | null | undefined;
  snapshotRetentionDays?: number | undefined;
  defaultFreshnessSlaHours?: number | undefined;
  maxSnapshotAgeDays?: number | undefined;
  batchThresholdPercent?: number | undefined;
  perResourceThresholdPercent?: number | undefined;
  personPopulationDropPercent?: number | undefined;
  minimumCoveragePercent?: number | undefined;
  bulkCertifyLimit?: number | undefined;
  dispatchSlaHours?: number | undefined;
  privilegedRecertifyDays?: number | undefined;
  maxExceptionDays?: number | undefined;
  exceptionWarningDays?: number[] | undefined;
  minReciprocalDecisions?: number | undefined;
  reciprocityWindowDays?: number | undefined;
}

export const GOVERN_SETTING_KEYS: readonly (keyof GovernSettingsInput)[] = [
  'snapshotSchedule',
  'snapshotRetentionDays',
  'defaultFreshnessSlaHours',
  'maxSnapshotAgeDays',
  'batchThresholdPercent',
  'perResourceThresholdPercent',
  'personPopulationDropPercent',
  'minimumCoveragePercent',
  'bulkCertifyLimit',
  'dispatchSlaHours',
  'privilegedRecertifyDays',
  'maxExceptionDays',
  'exceptionWarningDays',
  'minReciprocalDecisions',
  'reciprocityWindowDays',
];

/** A type-level guard: the runtime list and the interface cannot drift apart. */
type _KeysCovered = MutuallyAssignable<
  keyof GovernSettingsInput,
  (typeof GOVERN_SETTING_KEYS)[number]
>;

/**
 * The HTTP body and this input cannot drift apart either.
 *
 * It lives here rather than beside the schema because `@syntra/contracts` has
 * no dependency on `@syntra/core` — core depends on contracts — so the guard
 * only compiles on this side. `z.infer` over a `.partial().strict()` object is
 * an ordinary type (no `z.lazy`, no `z.ZodType<T>` annotation), so this guard
 * actually bites: add a key to one side and the other side stops compiling.
 */
type _SettingsBodyMatches = MutuallyAssignable<
  z.infer<typeof governSettingsBody>,
  GovernSettingsInput
>;

export class UnknownSettingError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(
      `these are not Govern settings and cannot be written here: ${keys.join(', ')}. ` +
        `lastAppliedBatchAt and personsWithActiveContractAtLastBatch are written only by ` +
        `confirmRevocationBatch, because they are the denominator the population-collapse ` +
        `refusal compares against.`,
    );
    this.name = 'UnknownSettingError';
  }
}

export async function updateGovernSettings(
  tenantId: string,
  actorUserId: string | null,
  input: GovernSettingsInput,
): Promise<void> {
  // The runtime backstop. The type stops a caller inside this package; this
  // stops a JSON body, which is where the request actually comes from.
  const unknown = Object.keys(input).filter(
    (key) => !(GOVERN_SETTING_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) throw new UnknownSettingError(unknown);

  for (const field of PERCENT_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value === 'number' && (value < 0 || value > 100)) {
      throw new Error(`${field} must be between 0 and 100`);
    }
  }

  await withTenant(tenantId, async (tx) => {
    const before = await governSettings(tx);

    // The zod body infers every optional as `T | undefined`, and under
    // `exactOptionalPropertyTypes` Prisma's generated update type does not
    // admit a present key whose value is `undefined`. Dropping the absent keys
    // is a normalisation rather than a way around the type system: what
    // remains is exactly the keys the caller set, and `GOVERN_SETTING_KEYS`
    // above has already refused anything not on the allow-list.
    //
    // Cast to the NAMED generated type, never `as never`: this one still
    // checks that the values are the right shape for the columns, which is the
    // whole property Global Constraint 12 is protecting.
    const data = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Prisma.GovernSettingsUpdateInput;

    const after = await tx.governSettings.update({ where: { tenantId }, data });

    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(input)) {
      const from = (before as Record<string, unknown>)[key];
      const to = (after as Record<string, unknown>)[key];
      if (JSON.stringify(from) !== JSON.stringify(to)) changed[key] = { from, to };
    }

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.settings.update',
      targetType: 'GovernSettings',
      targetId: after.id,
      outcome: 'success',
      sourceIp: null,
      payload: { changed },
    });
  });
}

export async function upsertSourcePolicy(
  tenantId: string,
  actorUserId: string | null,
  input: {
    sourceKind: string;
    sourceId: string;
    freshnessSlaHours: number;
    inDefaultScope: boolean;
  },
): Promise<void> {
  if (input.freshnessSlaHours <= 0) {
    throw new Error('a freshness SLA must be a positive number of hours');
  }
  await withTenant(tenantId, async (tx) => {
    await tx.governSourcePolicy.upsert({
      where: {
        tenantId_sourceKind_sourceId: {
          tenantId,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
        },
      },
      create: { tenantId, ...input },
      update: {
        freshnessSlaHours: input.freshnessSlaHours,
        inDefaultScope: input.inDefaultScope,
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.source_policy.update',
      targetType: 'GovernSourcePolicy',
      targetId: null,
      outcome: 'success',
      sourceIp: null,
      payload: { ...input },
    });
  });
}

/**
 * Raising a classification takes effect at the NEXT snapshot, and the finding
 * it produces says which snapshot first saw it. Rewriting a frozen snapshot to
 * agree with today's opinion would change what somebody attested to.
 */
export async function setResourceClassification(
  tenantId: string,
  actorUserId: string | null,
  input: {
    systemId: string;
    resourceKind: string;
    resourceId: string;
    privileged: boolean;
    note: string | null;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.resourceClassification.upsert({
      where: {
        tenantId_systemId_resourceKind_resourceId: {
          tenantId,
          systemId: input.systemId,
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
        },
      },
      create: { tenantId, ...input, setByUserId: actorUserId },
      update: {
        privileged: input.privileged,
        note: input.note,
        setByUserId: actorUserId,
        setAt: new Date(),
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.classification.set',
      targetType: 'ResourceClassification',
      targetId: null,
      outcome: 'success',
      sourceIp: null,
      payload: { ...input },
    });
  });
}
