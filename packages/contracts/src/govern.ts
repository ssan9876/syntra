import { z } from 'zod';

export const governSnapshotQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const buildSnapshotBody = z.object({
  kind: z.enum(['manual', 'campaign']).default('manual'),
});

export const systemReportQuery = z.object({
  snapshotId: z.string().uuid().optional(),
  systemId: z.string().min(1),
  resourceId: z.string().min(1).optional(),
});

export const personReportQuery = z.object({
  snapshotId: z.string().uuid().optional(),
});

export const changeReportQuery = z.object({
  fromSnapshotId: z.string().uuid(),
  toSnapshotId: z.string().uuid(),
});

export const approvalReportQuery = z.object({
  snapshotId: z.string().uuid().optional(),
  subjectKey: z.string().min(1),
  systemId: z.string().min(1),
  resourceKind: z.enum([
    'targetEntitlement',
    'targetAccount',
    'syntraGroup',
    'application',
    'syntraRole',
    'syntraUser',
  ]),
  resourceId: z.string().min(1),
});

export const exportCsvBody = systemReportQuery;

export const evidencePackBody = z.object({
  kind: z.enum(['campaign', 'report', 'period']),
  snapshotId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  scope: z.record(z.unknown()).default({}),
});

export const findingQuery = z.object({
  status: z.enum(['open', 'acknowledged', 'accepted', 'resolved']).optional(),
  kind: z.string().min(1).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const assignFindingBody = z.object({
  ownerPersonId: z.string().uuid(),
  dueAt: z.coerce.date(),
});

export const acceptFindingBody = z.object({
  // `.min(1)` on both, deliberately: the empty string is the universal
  // justification, and an acceptance with no reason is not an acceptance.
  reason: z.string().min(1),
  until: z.coerce.date(),
});

export const resolveRemediationBody = z.object({
  status: z.enum(['done', 'wont_fix']),
  comment: z.string().min(1),
});

export const denyOrphanBody = z.object({ reason: z.string().min(1) });

export const refreshSourceParams = z.object({
  kind: z.enum(['directorySource', 'targetSystem']),
  id: z.string().uuid(),
});

export const governSettingsBody = z
  .object({
    snapshotSchedule: z.string().min(1).nullable(),
    snapshotRetentionDays: z.number().int().min(1),
    defaultFreshnessSlaHours: z.number().int().min(1),
    maxSnapshotAgeDays: z.number().int().min(1),
    batchThresholdPercent: z.number().int().min(0).max(100),
    perResourceThresholdPercent: z.number().int().min(0).max(100),
    personPopulationDropPercent: z.number().int().min(0).max(100),
    minimumCoveragePercent: z.number().int().min(0).max(100),
    bulkCertifyLimit: z.number().int().min(1).max(1000),
    dispatchSlaHours: z.number().int().min(1),
    privilegedRecertifyDays: z.number().int().min(1),
    maxExceptionDays: z.number().int().min(1).max(365),
    exceptionWarningDays: z.array(z.number().int().min(0)).min(1),
    minReciprocalDecisions: z.number().int().min(1),
    reciprocityWindowDays: z.number().int().min(1),
  })
  // STRICT, not the default strip. Zod's default silently DROPS an unknown key
  // and returns a clean object, so a body naming
  // `personsWithActiveContractAtLastBatch` would be accepted with a 204 and no
  // write — which reads to a caller as success. `.strict()` makes it a 400, and
  // `updateGovernSettings` refuses the same key again as the runtime backstop,
  // because the contract package is not the only caller of the domain function.
  .strict()
  .partial();

/**
 * The type-level guard that this schema and `GovernSettingsInput` stay the same
 * shape lives in `packages/core/src/govern/settings-service.ts`, NOT here.
 *
 * `@syntra/contracts` has no dependency on `@syntra/core` — core depends on
 * contracts, not the other way round — so importing `GovernSettingsInput` into
 * this file would invert the dependency and create a cycle. Core can see both
 * types; contracts can see only one. The guard is written where it compiles.
 */

export const classificationBody = z.object({
  systemId: z.string().min(1),
  resourceKind: z.string().min(1),
  resourceId: z.string().min(1),
  privileged: z.boolean(),
  note: z.string().nullable().default(null),
});
