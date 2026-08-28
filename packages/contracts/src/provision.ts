import { z } from 'zod';
import { cronExpression } from './sync.js';

export const enforcementModeSchema = z.enum(['additive', 'authoritative']);

/**
 * Trimmed, and refused when trimming leaves nothing — the same shape, and for
 * the same reasons, as `directoryString` in `@syntra/connectors`'
 * `adTargetConfigSchema`, where the reasoning is written out.
 *
 * The two schemas have to agree on what they refuse. This one is what an
 * administrator's save is checked against and what gets STORED; the connector
 * parses the stored object again before every run. A value this accepted and
 * that refused would be a 204 on a target that then fails to parse its own
 * configuration on every run, which is the "save that reports success and
 * changed nothing" this file's `.strict()` exists to prevent, one layer down.
 */
const directoryString = z.string().trim().min(1);

/**
 * `.strict()`, and this is the object where it matters most.
 *
 * Target config is **replaced whole** rather than merged, so without it a typo
 * in a field name is dropped by Zod and the field it meant to set silently
 * reverts to its schema default. `primaryGroupExternalIds` misspelled goes
 * back to `[]`; `provenanceAttribute` misspelled goes back to `info` — and the
 * caller is told 204. An administrator narrowing a target's behaviour after an
 * incident gets a save that reports success and changed nothing.
 *
 * Note for anyone writing a test against this: in Zod, `.partial()` and
 * `.extend()` PRESERVE `unknownKeys`, so `createTargetRequestSchema.partial()`
 * is still strict. `.passthrough()` is what reverses it. A test that mutates
 * strictness must use `.passthrough()`; one that deletes `.strict()` from a
 * derived schema proves nothing, because the derivation kept it.
 */
export const targetConfigSchema = z
  .object({
    url: directoryString,
    // `plain` is absent: writes to a target require an encrypted transport
    // unconditionally, and a target that could be configured to write in the
    // clear is a target that eventually does.
    tlsMode: z.enum(['ldaps', 'starttls']),
    rejectUnauthorized: z.boolean().default(true),
    bindDn: directoryString,
    baseDn: directoryString,
    entitlementSearchBase: directoryString,
    archiveContainer: directoryString,
    provenanceAttribute: directoryString.default('info'),
    anchorAttribute: directoryString.default('objectGUID'),
    accountFilter: directoryString.default(
      '(&(objectCategory=person)(objectClass=user))',
    ),
    groupFilter: directoryString.default('(objectClass=group)'),
    primaryGroupExternalIds: z.array(directoryString).default([]),
    pageSize: z.number().int().positive().max(5000).default(1000),
    connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
    timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  })
  .strict();

/**
 * The SCIM 2.0 target's own config shape, kept in parallel with
 * `@syntra/connectors`' `scim2TargetConfigSchema` for the same reason
 * `targetConfigSchema` above is kept in parallel with `adTargetConfigSchema`:
 * this one is what an administrator's save is checked against at the outer
 * boundary, the connector's own copy parses the stored object again before
 * every run, and `.strict()` here is what turns a typo'd field name into a
 * 400 instead of a save that silently reverts that field to its default.
 */
export const scim2TargetConfigSchema = z
  .object({
    baseUrl: directoryString.refine(
      (v) => v.startsWith('http://') || v.startsWith('https://'),
      { message: 'baseUrl must start with http:// or https://' },
    ),
    userResourcePath: directoryString.default('/Users'),
    groupResourcePath: directoryString.default('/Groups'),
    pageSize: z.number().int().positive().max(1000).default(200),
    connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
    timeoutMs: z.number().int().positive().max(600_000).default(60_000),
    allowPrivateAddresses: z.boolean().default(false),
  })
  .strict();

/**
 * The declarative connector's config: one embedded document.
 *
 * Deliberately NOT restated field by field here, unlike the two above.
 * `httpConnectorDocument` in `@syntra/connectors` is a hundred lines of nested
 * unions, and a hand-kept parallel copy of it would be wrong within a release
 * — the parallel copies above earn their keep because they are a dozen flat
 * fields each. What this schema still buys is the `.strict()` on the wrapper:
 * a body that puts anything but `document` in `config` is a 400 here, and the
 * route's own `targetConfigSchemaFor(type)` re-validation is what checks the
 * document itself, against the one definition of it that exists.
 */
export const httpTargetConfigSchema = z
  .object({ document: z.record(z.unknown()) })
  .strict();

/** Every `TargetSystem.type` the API accepts, kept in step with `@syntra/connectors`' `TARGET_CONNECTOR_TYPES`. */
export const targetTypeSchema = z.enum(['activeDirectory', 'scim2', 'httpJson']);

/**
 * Either connector's config shape. Not a discriminated union on `type`
 * because `type` lives as a sibling field on the request body, not inside
 * `config` itself — the route layer's own re-validation via
 * `targetConfigSchemaFor(type)` in `@syntra/core` is what actually ties the
 * two together; this union exists so a mistyped field name is still a 400 at
 * this outer boundary rather than silently accepted as `unknown`.
 */
const anyTargetConfigSchema = z.union([
  targetConfigSchema,
  scim2TargetConfigSchema,
  httpTargetConfigSchema,
]);

/**
 * `.strict()` on the request bodies, and it is not decoration.
 *
 * `TargetSystem.concurrency` is stored, validated and rendered, and the apply
 * loop is sequential — the setting has never done anything. It is therefore
 * deliberately ABSENT from these schemas: an API that accepts a knob which
 * changes nothing tells its caller a lie that no amount of documentation
 * unsays. Without `.strict()` Zod would silently strip it, which is the same
 * lie with a 204 on it; with `.strict()` a caller who sends it is told the
 * field is not accepted.
 *
 * The same reasoning covers every mistyped field name: a `PATCH` that saves
 * nothing must not answer 204.
 */
export const createTargetRequestSchema = z
  .object({
    name: z.string().min(1),
    type: targetTypeSchema,
    config: anyTargetConfigSchema,
    bindPassword: z.string().min(1).max(1024),
    pairedDirectorySourceId: z.string().uuid().nullable().optional(),
    /**
     * The same validator Directory Sync uses, because it is the same pg-boss.
     *
     * `z.string()` accepted `0 2 * *` -- four fields, the ordinary typo --
     * which commits, audits as a success and only then throws out of
     * `boss.schedule`, leaving the stored schedule and the firing schedule
     * permanently disagreeing with a bare 500 as the only signal. The
     * direction that costs access is a target that had no schedule before:
     * the row now claims a nightly run, nothing ever fires, and because no
     * run starts there is no `consecutiveSkippedRuns` and no
     * `lastSkipReason` either -- none of the Ruling P4 signals that exist to
     * make a target which has stopped running look different from one running
     * cleanly.
     *
     * `null` clears the schedule and is how a target is made manual-only.
     * The empty string is not a third option: it is not a cron expression,
     * and `.min(1)` refuses it here rather than letting it mean `null` by
     * accident somewhere further down.
     */
    schedule: cronExpression.nullable().optional(),
    autoApply: z.boolean().optional(),
    enabled: z.boolean().optional(),
    enforcementMode: enforcementModeSchema.optional(),
  })
  .strict();
export type CreateTargetRequest = z.input<typeof createTargetRequestSchema>;

export const ladderSchema = z
  .object({
    entitlementRevocationDelayDays: z.number().int().min(0).max(3650).optional(),
    disableGraceDays: z.number().int().min(0).max(3650).optional(),
    archiveAfterDays: z.number().int().min(0).max(3650).nullable().optional(),
    reenableWithoutConfirmationDays: z.number().int().min(0).max(3650).optional(),
    renameEnabled: z.boolean().optional(),
  })
  .strict();

export const thresholdsSchema = z
  .object({
    createAccountThresholdPercent: z.number().int().min(0).max(100).optional(),
    disableAccountThresholdPercent: z.number().int().min(0).max(100).optional(),
    archiveAccountThresholdPercent: z.number().int().min(0).max(100).optional(),
    revokeEntitlementThresholdPercent: z.number().int().min(0).max(100).optional(),
    deactivateSyntraUserThresholdPercent: z.number().int().min(0).max(100).optional(),
    perEntitlementThresholdPercent: z.number().int().min(0).max(100).optional(),
    personPopulationDropPercent: z.number().int().min(0).max(100).optional(),
    /**
     * An absolute COUNT, which is why its bound is 1000 rather than 100 and
     * its name carries no `Percent`.
     *
     * Containers have no population to be a share of, so this axis is a cap.
     * Zero is permitted and means no run may create a container at all.
     */
    maxContainerCreatesPerRun: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const updateTargetRequestSchema = createTargetRequestSchema
  .partial()
  .extend({
    ladder: ladderSchema.optional(),
    thresholds: thresholdsSchema.optional(),
    preHireDays: z.number().int().min(0).max(365).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export type UpdateTargetRequest = z.input<typeof updateTargetRequestSchema>;

export const testTargetRequestSchema = z
  .object({
    type: targetTypeSchema,
    config: anyTargetConfigSchema,
    bindPassword: z.string().min(1).max(1024).optional(),
    borrowFromTargetId: z.string().uuid().optional(),
  })
  .strict();

/**
 * How deeply a condition arriving over HTTP may nest, and how many nodes it
 * may hold.
 *
 * These are the numbers `businessRuleSchema` in `@syntra/core` enforces at the
 * write boundary, and they live HERE because this is the outer boundary:
 * `@syntra/core` depends on `@syntra/contracts`, so core imports them rather
 * than restating them. Two copies of a cap that must agree is a cap that
 * eventually does not — and the dangerous direction is silent, because a
 * looser edge simply lets the deep body through to the recursive parser it was
 * meant to keep it away from.
 *
 * Both numbers are far above any rule a person writes. A condition twelve
 * levels deep is already unreadable; a hundred nodes is already a rule that
 * wants to be several.
 */
export const MAX_CONDITION_DEPTH = 32;
export const MAX_CONDITION_NODES = 512;

/**
 * Walks a raw condition **iteratively**, before any recursive schema sees it.
 *
 * An explicit stack rather than recursion, because a recursive bounds check
 * overflows on exactly the input it exists to refuse — which would make the
 * check the vulnerability. Nothing here parses or trusts the shape; it only
 * follows the three keys that nest.
 */
export function conditionBoundsProblem(raw: unknown): string | null {
  const stack: { node: unknown; depth: number }[] = [{ node: raw, depth: 1 }];
  let nodes = 0;

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;

    nodes += 1;
    if (nodes > MAX_CONDITION_NODES) {
      return `a condition may hold at most ${MAX_CONDITION_NODES} nodes`;
    }
    if (depth > MAX_CONDITION_DEPTH) {
      return `a condition may nest at most ${MAX_CONDITION_DEPTH} levels deep`;
    }

    const record = node as Record<string, unknown>;
    for (const key of ['all', 'any'] as const) {
      const children = record[key];
      if (Array.isArray(children)) {
        for (const child of children) stack.push({ node: child, depth: depth + 1 });
      }
    }
    if ('not' in record) stack.push({ node: record.not, depth: depth + 1 });
  }

  return null;
}

/**
 * The recursive transport shape. Unbounded on its own, which is why nothing
 * exports it: {@link conditionRequestSchema} is the bounded wrapper and is the
 * only thing a route may parse with.
 */
const unboundedConditionRequestSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(unboundedConditionRequestSchema) }).strict(),
    z.object({ any: z.array(unboundedConditionRequestSchema) }).strict(),
    z.object({ not: unboundedConditionRequestSchema }).strict(),
    z.record(z.unknown()),
  ]),
);

/**
 * The TRANSPORT shape of a condition, and deliberately not the real one.
 *
 * `@syntra/contracts` cannot import the closed field and operator sets from
 * `@syntra/core` without inverting the dependency, so the leaf falls back to
 * an open record here. That makes this schema a shape check and a bounds check
 * and nothing more: a leaf naming `contract.salary`, or `op: 'regex'`, parses
 * cleanly.
 *
 * **Every route that touches a condition therefore re-parses it with
 * `boundedConditionSchema` from `@syntra/core` before evaluating or storing
 * it.** Without that second parse, `evaluateCondition` falls through both of
 * its switches on a malformed leaf and returns `undefined`, which `.some()`
 * reads as false: the rule previews as "matches 0 persons", which is
 * indistinguishable from a correctly narrow rule, and it gets saved.
 *
 * ## The bounds are applied HERE, not only behind this schema
 *
 * Core's `businessRuleSchema` caps depth and node count too — but core's cap
 * runs *after* this parser, and this parser is the recursive one. A 20,000-deep
 * body would blow the stack inside the `z.lazy` above and come back as a bare
 * 500 from a body the caller chose the size of, on the one endpoint an
 * administrator uses to fix rules. A cap that sits behind the parser it is
 * meant to protect is not a cap, so the same iterative walk runs first here.
 *
 * `z.preprocess` runs BEFORE the wrapped schema and `fatal: true` stops the
 * pipeline there, so an over-deep condition is refused without the recursive
 * schema ever being entered.
 */
export const conditionRequestSchema: z.ZodType<unknown> = z.preprocess(
  (raw, ctx) => {
    const problem = conditionBoundsProblem(raw);
    if (problem !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, fatal: true });
      return z.NEVER;
    }
    return raw;
  },
  unboundedConditionRequestSchema,
);

export const businessRuleRequestSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    condition: conditionRequestSchema,
    grantsAccount: z.boolean(),
    enabled: z.boolean(),
    entitlementIds: z.array(z.string().uuid()),
  })
  .strict();
export type BusinessRuleRequest = z.input<typeof businessRuleRequestSchema>;

export const accountProfileRequestSchema = z
  .object({
    correlationKeyTemplate: z.string().min(1),
    uniquenessStrategy: z.literal('numericSuffix').default('numericSuffix'),
    maxUniquenessAttempts: z.number().int().positive().max(200),
    containerTemplate: z.string().min(1),
    fallbackContainer: z.string().min(1),
    attributeTemplates: z.record(z.string()),
    initialPasswordPolicy: z.record(z.unknown()),
    initialPasswordDelivery: z.enum(['manager', 'personalEmail', 'vaultOnly']),
  })
  .strict();
export type AccountProfileRequest = z.input<typeof accountProfileRequestSchema>;

export const applyRunRequestSchema = z
  .object({
    /** Action ids to apply. Omitted, every proposed action is applied. */
    only: z.array(z.string().uuid()).optional(),
    /** Required to apply a blocked run, or any action needing confirmation. */
    confirm: z.boolean().default(false),
  })
  .strict();
export type ApplyRunRequest = z.input<typeof applyRunRequestSchema>;

export const acknowledgeDriftRequestSchema = z
  .object({
    status: z.enum(['acknowledged', 'resolved']),
  })
  .strict();

/**
 * Moving one person's account to a container somebody chose.
 *
 * `reason` is required and non-blank, deliberately. This row is what stops the
 * planner putting the account back, so it is a standing disagreement with the
 * placement rule — and "who moved this and why" is the only question anybody
 * asks about an account that is not where the rule says it should be. A
 * reason nobody had to give is a reason nobody gives.
 */
export const movePlacementRequest = z
  .object({
    container: z.string().trim().min(1).max(1024),
    reason: z.string().trim().min(1).max(512),
  })
  .strict();

export const placementResponse = z.object({
  personId: z.string().uuid(),
  targetSystemId: z.string().uuid(),
  container: z.string(),
  reason: z.string(),
  movedByUserId: z.string().uuid().nullable(),
  updatedAt: z.string(),
});

export const containerListResponse = z.object({
  containers: z.array(z.string()),
});

export type MovePlacementRequest = z.infer<typeof movePlacementRequest>;
export type PlacementResponse = z.infer<typeof placementResponse>;

/**
 * Materialising an org unit against one target.
 *
 * The DN is typed by an administrator rather than chosen from a list, because
 * the container usually does not exist yet -- that is the point of the
 * request. It is validated against the target's base DN on the way in.
 */
export const materialiseOrgUnitRequest = z
  .object({
    targetSystemId: z.string().uuid(),
    dn: z.string().min(1).max(1024),
  })
  .strict();
