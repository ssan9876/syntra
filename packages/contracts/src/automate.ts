import { z } from 'zod';

export const resourceType = z.enum(['entitlement', 'application', 'group']);

/**
 * The resource types a DELEGATION may name.
 *
 * `entitlement` is deliberately absent. `delegatedGrant` writes a
 * `RequestItem` with `targetSystemId: null`, `fulfilRequest` copies that onto
 * the `AccessGrant`, and `access_grant_target_matches_type` rejects
 * `('entitlement', null)` — a 500 out of the portal on a capability the
 * console would otherwise let an administrator configure. A target
 * entitlement is granted through a catalog product and a Provision run, which
 * is where its approval and its target write belong. Spec section 14 is
 * written entirely about groups a team lead owns.
 */
export const delegableResourceType = z.enum(['application', 'group']);
export const productKind = z.enum(['targetEntitlement', 'application', 'localGroup']);
export const durationMode = z.enum(['permanent', 'fixed', 'requesterChoice']);
export const approverSelector = z.enum([
  'manager',
  'managerChain',
  'productOwner',
  'resourceOwner',
  'role',
  'group',
  'person',
]);

/**
 * Not `z.any()`. The audience expression and the form schema are validated by
 * their own closed interpreters in `@syntra/core`, and re-declaring their
 * grammar here would be a second definition to keep in agreement. `unknown`
 * hands them across intact and lets the one parser refuse what it refuses.
 */
const opaqueJson = z.unknown();

export const productGrantBody = z.object({
  resourceType,
  resourceId: z.string().uuid(),
  targetSystemId: z.string().uuid().nullable().default(null),
  optional: z.boolean().default(false),
});

export const productBody = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens'),
  description: z.string().max(2000).nullable().default(null),
  category: z.string().max(120).nullable().default(null),
  iconUrl: z.string().url().max(2048).nullable().default(null),
  requestInstructions: z.string().max(4000).nullable().default(null),
  kind: productKind,
  grants: z.array(productGrantBody).min(1),
  // Nullable and REQUIRED to be stated. There is no default, because the
  // default is "nobody" and an omitted field would read as an accident.
  audienceCondition: opaqueJson.nullable(),
  workflowId: z.string().uuid(),
  formSchema: opaqueJson.default([]),
  durationMode,
  defaultDurationDays: z.number().int().positive().max(3650).nullable().default(null),
  maxDurationDays: z.number().int().positive().max(3650).nullable().default(null),
  ownerPersonId: z.string().uuid().nullable().default(null),
  ownerGroupId: z.string().uuid().nullable().default(null),
  status: z.enum(['draft', 'active', 'retired']).default('draft'),
});
export type ProductBody = z.input<typeof productBody>;

export const stageBody = z.object({
  sequence: z.number().int().positive(),
  name: z.string().min(1).max(120),
  selector: approverSelector,
  selectorConfig: z
    .object({
      depth: z.number().int().min(1).max(5).optional(),
      roleId: z.string().uuid().optional(),
      groupId: z.string().uuid().optional(),
      personId: z.string().uuid().optional(),
    })
    .default({}),
  quorum: z.enum(['any', 'all']).default('any'),
  fallbackSelector: approverSelector.nullable().default(null),
  fallbackConfig: z
    .object({
      depth: z.number().int().min(1).max(5).optional(),
      roleId: z.string().uuid().optional(),
      groupId: z.string().uuid().optional(),
      personId: z.string().uuid().optional(),
    })
    .default({}),
  slaHours: z.number().int().positive().max(8760).default(48),
  // THERE IS NO 'approve'. Approval by inattention is a privilege grant
  // nobody made, and the enum is where that is enforced at the edge.
  onTimeout: z.enum(['remind', 'escalate', 'expire']).default('remind'),
  escalationSelector: approverSelector.nullable().default(null),
  escalationConfig: z
    .object({
      depth: z.number().int().min(1).max(5).optional(),
      roleId: z.string().uuid().optional(),
      groupId: z.string().uuid().optional(),
      personId: z.string().uuid().optional(),
    })
    .default({}),
  expiryHours: z.number().int().positive().max(8760).nullable().default(null),
});

export const workflowBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  enabled: z.boolean().default(true),
  /** An EMPTY list means granted immediately, and the editor says so. */
  stages: z.array(stageBody).max(10),
});
export type WorkflowBody = z.input<typeof workflowBody>;

export const submitRequestBody = z.object({
  productId: z.string().uuid(),
  // OPTIONAL, because absent means "for myself" — which is what the portal's
  // own request form sends, and what `subjectFor` was written to handle:
  // `(request, requested: string | undefined)`, returning the caller's own
  // person when nothing was named. Required here, the two disagreed and every
  // request submitted from the portal was refused with "Validation failed"
  // before it reached the handler that knew what to do with it.
  subjectPersonId: z.string().uuid().optional(),
  justification: z.string().max(4000).nullable().default(null),
  formValues: z.record(z.unknown()).default({}),
  requestedDurationDays: z.number().int().positive().max(3650).nullable().default(null),
  replacesGrantId: z.string().uuid().nullable().default(null),
});
export type SubmitRequestBody = z.input<typeof submitRequestBody>;

export const decideRequestBody = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().max(4000).nullable().default(null),
    shortenedToDays: z.number().int().positive().max(3650).nullable().default(null),
  })
  .refine((v) => v.decision !== 'reject' || (v.comment ?? '').trim() !== '', {
    message: 'Say why. A refusal with no reason is a request the person will raise again.',
    path: ['comment'],
  });
export type DecideRequestBody = z.input<typeof decideRequestBody>;

/**
 * Withdrawing a grant administratively.
 *
 * `.strict()`, and the reason is the one `provision.ts` writes out: this route
 * was reading `(request.body ?? {}) as { reason?: string }`, so a `resaon`
 * typo silently became the default reason and a number became a number in the
 * audit payload. The default is preserved -- an API caller who says nothing is
 * still saying "withdrawn by an administrator" -- but a caller who says
 * something wrong is now told.
 */
export const revokeGrantBody = z
  .object({
    reason: z.string().min(1).max(1000).default('withdrawn by an administrator'),
  })
  .strict();
export type RevokeGrantBody = z.input<typeof revokeGrantBody>;

export const audiencePreviewBody = z.object({
  audienceCondition: opaqueJson.nullable(),
  // Optional and UNBOUNDED by default. The console's copy is "412 of 1,180 —
  // show me who", and a default of 25 answers a different question from the
  // one it asks while `matched` goes on reporting 412. The cap is a page
  // size for a caller that wants one, not a silent truncation of the answer.
  limit: z.number().int().min(1).max(5000).optional(),
});

export const resolutionPreviewBody = z.object({
  workflowId: z.string().uuid(),
  subjectPersonId: z.string().uuid(),
  productId: z.string().uuid().nullable().default(null),
});

export const sweepApplyBody = z.object({
  confirm: z.boolean().default(false),
  /** Absent means every proposed action; an empty array means none of them. */
  only: z.array(z.string().uuid()).optional(),
});

export const delegatedGrantBody = z.object({
  subjectPersonIds: z.array(z.string().uuid()).min(1),
  justification: z.string().min(1).max(4000),
  durationDays: z.number().int().positive().max(3650).nullable().default(null),
});

export const approvalDelegationBody = z.object({
  delegatorPersonId: z.string().uuid(),
  delegatePersonId: z.string().uuid(),
  category: z.string().max(120).nullable().default(null),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

export const resourceDelegationBody = z.object({
  resourceType: delegableResourceType,
  resourceId: z.string().uuid(),
  delegatePersonId: z.string().uuid().nullable().default(null),
  delegateGroupId: z.string().uuid().nullable().default(null),
  capabilities: z.array(z.enum(['view_members', 'approve', 'grant', 'revoke'])).min(1),
  audienceCondition: opaqueJson.nullable(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().default(null),
});

export const resourceOwnerBody = z.object({
  resourceType,
  resourceId: z.string().uuid(),
  ownerPersonId: z.string().uuid().nullable().default(null),
  ownerGroupId: z.string().uuid().nullable().default(null),
});

export const settingsBody = z.object({
  sweepSchedule: z.string().max(120).nullable().optional(),
  sweepThresholdPercent: z.number().int().min(0).max(100).optional(),
  perProductSweepThresholdPercent: z.number().int().min(0).max(100).optional(),
  personPopulationDropPercent: z.number().int().min(0).max(100).optional(),
  fulfilmentSlaHours: z.number().int().positive().max(8760).optional(),
  expiryWarningDays: z.array(z.number().int().positive().max(365)).max(6).optional(),
  preHireHorizonDays: z.number().int().min(0).max(365).optional(),
  // 365, matching `SETTING_BOUNDS` in `catalog-service.ts`, NOT 3650. An
  // earlier draft accepted ten years here and the service refused anything
  // over one -- a route that accepts 400 and a service that rejects it.
  // Global Constraint 14: an indefinite delegation is a permanent transfer of
  // authority that nobody ever re-decides.
  maxDelegationDays: z.number().int().positive().max(365).optional(),
  maxApprovers: z.number().int().positive().max(100).optional(),
  delegatedBulkLimit: z.number().int().positive().max(1000).optional(),
});

/** The path parameter on every delegated portal act. Delegable types only. */
export const resourceParam = z.object({
  type: delegableResourceType,
  id: z.string().uuid(),
});

export const catalogSearchQuery = z.object({
  q: z.string().max(200).default(''),
});

/**
 * Delegated tasks: a form somebody may fill in to make one narrow change,
 * without holding the permission that change would normally need.
 *
 * `actionKey` is validated against the library in `@syntra/core` rather than
 * restated as an enum here. A parallel copy of a list that lives in code —
 * unlike the flat connector configs, which earn their copies — is a list that
 * drifts, and the service refuses an unknown key by name anyway.
 */
export const delegatedTaskRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().default(null),
    actionKey: z.string().trim().min(1).max(64),
    formSchema: z.array(z.record(z.unknown())).max(40).default([]),
    /**
     * Who may run it. `null` admits NOBODY, which is `audienceAdmits`'s own
     * default — a task nobody finished configuring must not be runnable by
     * everyone.
     */
    audienceCondition: z.record(z.unknown()).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict();

export const runTaskRequest = z
  .object({
    values: z.record(z.unknown()).default({}),
  })
  .strict();

export const delegatedTaskResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  actionKey: z.string(),
  actionLabel: z.string(),
  formSchema: z.array(z.record(z.unknown())),
  audienceCondition: z.record(z.unknown()).nullable(),
  enabled: z.boolean(),
});

export type DelegatedTaskRequest = z.infer<typeof delegatedTaskRequest>;
export type DelegatedTaskResponse = z.infer<typeof delegatedTaskResponse>;
