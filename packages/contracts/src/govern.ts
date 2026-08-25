import { z } from 'zod';
import { conditionRequestSchema } from './provision.js';

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

// ---------------------------------------------------------------------------
// Slice 2: campaigns, revocation batches and segregation of duties.
// ---------------------------------------------------------------------------

/**
 * The scope language, mirroring `CampaignScope` in `@syntra/core`.
 *
 * `@syntra/contracts` has no dependency on `@syntra/core` — core depends on
 * contracts — so the two cannot be one declaration. `campaign-service.ts`
 * carries three `MutuallyAssignable` guards that fail to compile if they drift,
 * including one over `keyof` both sides, because assignability alone cannot see
 * a MISSING optional.
 */
export const campaignScopeInput = z.object({
  // `.min(1)`: "review the finance system" with a blank kind list must cover
  // NOTHING rather than the tenant.
  resourceKinds: z
    .array(
      z.enum([
        'targetEntitlement',
        'targetAccount',
        'syntraGroup',
        'application',
        'syntraRole',
        'syntraUser',
      ]),
    )
    .min(1),
  systemIds: z.array(z.string().min(1)).min(1).optional(),
  privilegedOnly: z.boolean().optional(),
  orgUnitIds: z.array(z.string().uuid()).min(1).optional(),
  riskFlags: z.array(z.string().min(1)).min(1).optional(),
  // `conditionRequestSchema`, not a second recursive schema written here. It
  // is the BOUNDED wrapper — a depth and width cap applied iteratively, before
  // any recursive schema sees the value — and a scope condition arrives from
  // the same untrusted place a rule condition does.
  subjectCondition: conditionRequestSchema.optional(),
});

export const campaignListQuery = z.object({
  status: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const createCampaignBody = z.object({
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  scope: campaignScopeInput,
  reviewerSelector: z.string().min(1),
  reviewerConfig: z.record(z.unknown()).default({}),
  fallbackSelector: z.string().min(1),
  fallbackConfig: z.record(z.unknown()).default({}),
  ownerPersonId: z.string().uuid(),
  opensAt: z.coerce.date(),
  dueAt: z.coerce.date(),
  allowBulkCertify: z.boolean().default(false),
  recurrence: z.string().min(1).nullable().default(null),
  snapshotId: z.string().uuid().optional(),
});

export const previewScopeBody = z.object({
  scope: campaignScopeInput,
  snapshotId: z.string().uuid().optional(),
});

export const previewReviewersBody = z.object({
  scope: campaignScopeInput,
  reviewerSelector: z.string().min(1),
  reviewerConfig: z.record(z.unknown()).default({}),
  fallbackSelector: z.string().min(1),
  fallbackConfig: z.record(z.unknown()).default({}),
  snapshotId: z.string().uuid().optional(),
});

export const extendCampaignBody = z.object({ dueAt: z.coerce.date() });

export const rebaseCampaignBody = z.object({ snapshotId: z.string().uuid() });

/**
 * REQUIRED, never defaulted.
 *
 * §13's second axis is a confirmation the caller has to make on purpose. A
 * default of `true` would make it a formality every caller passes by not
 * thinking about it, and a default of `false` would make the field pointless.
 * `.strict()` so a body that misspells it is a 400 rather than a silent refusal
 * the operator reads as a bug.
 */
export const confirmBatchBody = z.object({ confirmed: z.boolean() }).strict();

export const skipDispatchBody = z.object({ reason: z.string().min(1) });

const functionResource = z.object({
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

export const businessFunctionBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  ownerPersonId: z.string().uuid(),
  // A function with no resources can never be held, and a rule over it is a
  // rule that silently never fires. Refused here and again at save.
  resources: z.array(functionResource).min(1),
});

const severity = z.enum(['low', 'medium', 'high', 'critical']);

export const sodRuleBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  functionAId: z.string().uuid(),
  functionBId: z.string().uuid(),
  severity,
  // A rule nobody wrote a reason for is a rule nobody can argue with when it
  // fires against a real person.
  rationale: z.string().min(1),
  exceptionWorkflowId: z.string().uuid().nullable().default(null),
  enabled: z.boolean().default(true),
});

export const sodRulePreviewBody = z.object({
  functionAId: z.string().uuid(),
  functionBId: z.string().uuid(),
  severity,
});

export const violationQuery = z.object({
  status: z.enum(['open', 'excepted', 'resolved', 'unevaluable']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const requestExceptionBody = z.object({
  // Both required, and both `.min(1)` after trimming at the service. A
  // perpetual, unjustified, uncompensated exception is how an SoD programme
  // dies quietly.
  justification: z.string().min(1),
  compensatingControl: z.string().min(1),
  basisContractIds: z.array(z.string().uuid()).default([]),
  startsAt: z.coerce.date(),
  // There is no such thing as a permanent risk acceptance. The maximum is a
  // tenant setting and the service refuses past it.
  endsAt: z.coerce.date(),
});

export const decideExceptionBody = z.object({
  decision: z.enum(['approve', 'refuse']),
  comment: z.string().min(1),
});

/**
 * §15: an exception may be ended early "by an approver or the rule owner, with
 * a reason". The reason is required for the same purpose the justification is:
 * a risk acceptance that ends with no recorded reason is a decision nobody can
 * re-read.
 */
export const revokeExceptionBody = z.object({ reason: z.string().min(1) }).strict();

export const graphQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---- the portal ------------------------------------------------------------

export const decideItemBody = z
  .object({
    decision: z.enum(['certify', 'revoke']),
    // Nullable rather than optional: the SERVICE decides when a comment is
    // mandatory (a privileged holding, an unattributable one, a coverage gap),
    // because that rule belongs beside the state machine and not in a schema
    // the console could be updated without.
    comment: z.string().min(1).nullable().default(null),
  })
  .strict();

export const bulkCertifyBody = z
  .object({
    campaignId: z.string().uuid(),
    itemIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

export const reviewListQuery = z.object({
  campaignId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
