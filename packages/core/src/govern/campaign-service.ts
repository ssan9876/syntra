import { z } from 'zod';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import {
  conditionSchema,
  evaluateCondition,
  type Condition,
  type ConditionFacts,
} from '../provision/condition.js';
import { displayNames, enqueueOutbox, recipientsForPersons } from '../automate/notify.js';
import { checkSnapshotAge, checkSourceFreshness } from './freshness.js';
import { REVIEWER_BATCH, resolveItemReviewers } from './reviewer-service.js';
import { governSettings } from './settings-service.js';
import { readableSnapshot, type ReadableSnapshot } from './readable.js';
import { RESOURCE_KINDS, known, percentOf, type ResourceKind, type Tri } from './types.js';

export const ITEM_BATCH = 500;

export interface CampaignScope {
  /** AT LEAST ONE. An empty list means NOTHING, never everything. */
  resourceKinds: ResourceKind[];
  // `| undefined` on every optional: `exactOptionalPropertyTypes` is on
  // repo-wide, and a zod-inferred optional is `T | undefined`. Without it the
  // two sides of the guards below cannot match and no schema would satisfy
  // this type.
  systemIds?: string[] | undefined;
  privilegedOnly?: boolean | undefined;
  orgUnitIds?: string[] | undefined;
  subjectCondition?: Condition | undefined;
  riskFlags?: string[] | undefined;
}

const leafScopeSchema = z.object({
  // `.min(1)` is the whole point. "Review the finance system" with a blank kind
  // list must cover nothing rather than the tenant: a matching language's empty
  // pattern is its universal pattern unless something says otherwise.
  resourceKinds: z
    .array(z.enum(RESOURCE_KINDS as unknown as [ResourceKind, ...ResourceKind[]]))
    .min(1),
  systemIds: z.array(z.string().min(1)).min(1).optional(),
  privilegedOnly: z.boolean().optional(),
  orgUnitIds: z.array(z.string().uuid()).min(1).optional(),
  riskFlags: z.array(z.string().min(1)).min(1).optional(),
});

export const campaignScopeSchema = leafScopeSchema.extend({
  // `conditionSchema` already refuses a blank value at the schema and at a
  // runtime backstop, so the scope inherits both.
  subjectCondition: conditionSchema.optional(),
});

/**
 * `[A] extends [B] ? ([B] extends [A] ? true : never) : never` — the working
 * guard form. `<A extends B, B extends A>` is TS2313.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * The annotation `z.ZodType<CampaignScope>` would check NOTHING here if the
 * schema were recursive — deleting an entire arm of a `z.lazy` union still
 * compiles cleanly under it. This schema is not recursive, so the relationship
 * IS checkable, and these two guards check it in both directions. Delete a
 * field from either side and `tsc` fails.
 */
type ScopeFromSchema = z.infer<typeof campaignScopeSchema>;
// CONSTS assigned `true`, not bare type aliases. `type _X = never` compiles
// cleanly — the alias is simply `never` and nothing ever reads it — so the
// guard the plan described would have checked nothing at all. Assigning `true`
// to `never` is the error.
const _scopeAssignableToType: MutuallyAssignable<ScopeFromSchema, CampaignScope> = true;
const _typeAssignableToScope: MutuallyAssignable<CampaignScope, ScopeFromSchema> = true;
/**
 * And the KEYS, because the two guards above cannot see a missing OPTIONAL.
 *
 * Drop `privilegedOnly` from the schema and both directions still hold: an
 * object without an optional property is assignable to a type that has one, and
 * an extra property is assignable in the other direction. So the schema could
 * silently stop parsing a field the type still advertises — the scope would
 * accept it, strip it, and the campaign would cover more than the screen said.
 * `keyof` is exact in both directions and catches it.
 */
const _scopeKeysMatch: MutuallyAssignable<keyof ScopeFromSchema, keyof CampaignScope> = true;
void _scopeAssignableToType;
void _typeAssignableToScope;
void _scopeKeysMatch;

export class CampaignRefusedError extends Error {
  constructor(
    readonly code: 'stale_source' | 'stale_snapshot' | 'empty_scope' | 'not_draft',
    /** Which clock. A refusal that does not say is a refusal nobody can act on. */
    readonly clock: 'source' | 'snapshot' | null,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignRefusedError';
  }
}

/**
 * `coveragePercent = (decided + moot) / total`, defined ONCE because it is the
 * number people will quote.
 *
 * `moot` is in the numerator because a holding that no longer exists is not an
 * unanswered question. It is counted separately on the same line so a campaign
 * with 800 moot items — one somebody scoped against a picture the world had
 * moved past — is visible rather than flattering.
 */
export function coverageOf(counts: {
  total: number;
  decided: number;
  moot: number;
}): Tri<{ percent: number; numerator: number; denominator: number }> {
  return percentOf(counts.decided + counts.moot, known(counts.total));
}

interface ScopedHolding {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemId: string;
  resourceKind: string;
  resourceId: string;
  resourceName: string;
  observedAt: Date;
  privileged: boolean;
  unattributable: boolean;
  attributions: { kind: string; refId: string | null; detail: unknown }[];
  /**
   * `AccessGrant.needsReview` — Automate's mover flag, carried through to the
   * item. §12: "That flag exists precisely so a campaign can consume it, and it
   * is exactly the item a bulk certify must not sweep up." Without this field
   * it never reaches `riskFlags` and two of the five bulk-certify carve-outs
   * never fire.
   */
  needsReview: boolean;
  /** True when this (person, system, kind, resource) is on either side of an OPEN SodViolation. */
  inSodViolation: boolean;
}

async function holdingsInScope(
  tx: TenantClient,
  snapshot: ReadableSnapshot,
  scope: CampaignScope,
): Promise<ScopedHolding[]> {
  const holdingRows = await tx.holding.findMany({
    where: {
      snapshotId: snapshot.id,
      resourceKind: { in: scope.resourceKinds },
      ...(scope.systemIds === undefined ? {} : { systemId: { in: scope.systemIds } }),
      ...(scope.privilegedOnly === true ? { privileged: true } : {}),
    },
    include: { attributions: { select: { kind: true, refId: true, detail: true } } },
  });

  // ---- the two risk flags nothing else writes ------------------------------
  // Both are SET-BASED over the whole scope, never a per-subject query in a
  // loop over the tenant.
  const grants = await tx.accessGrant.findMany({
    where: { needsReview: true },
    select: { subjectPersonId: true, resourceType: true, resourceId: true },
  });
  const needsReviewKeys = new Set(
    grants.map((g) => `${g.subjectPersonId}|${g.resourceType}|${g.resourceId}`),
  );

  // `lastSnapshotId`, not `snapshotId`: the column records the snapshot in
  // which the violation was last observed, and there is no other. A violation
  // last seen in an OLDER snapshot must not flag an item in this one — the
  // holding may since have gone.
  const violations = await tx.sodViolation.findMany({
    where: { status: 'open', lastSnapshotId: snapshot.id },
    select: { personId: true, holdingsA: true, holdingsB: true },
  });
  const sodKeys = new Set<string>();
  for (const violation of violations) {
    for (const side of [violation.holdingsA, violation.holdingsB]) {
      for (const holding of side as {
        systemId: string;
        resourceKind: string;
        resourceId: string;
      }[]) {
        sodKeys.add(
          `${violation.personId}|${holding.systemId}|${holding.resourceKind}|${holding.resourceId}`,
        );
      }
    }
  }

  // Automate's `ResourceType` is 'entitlement' | 'application' | 'group'; a
  // grant is only ever over one of those three, so a Syntra role, a Syntra user
  // or a target account never matches and never carries `needs_review`. That is
  // correct rather than a gap: nothing grants those through Automate.
  const resourceTypeOf = (kind: string): string | null =>
    kind === 'application'
      ? 'application'
      : kind === 'syntraGroup'
        ? 'group'
        : kind === 'targetEntitlement'
          ? 'entitlement'
          : null;

  const rows: ScopedHolding[] = holdingRows.map((r) => {
    const type = resourceTypeOf(r.resourceKind);
    return {
      subjectKey: r.subjectKey,
      personId: r.personId,
      accountRef: r.accountRef,
      systemId: r.systemId,
      resourceKind: r.resourceKind,
      resourceId: r.resourceId,
      resourceName: r.resourceName,
      observedAt: r.observedAt,
      privileged: r.privileged,
      unattributable: r.unattributable,
      attributions: r.attributions,
      needsReview:
        r.personId !== null &&
        type !== null &&
        needsReviewKeys.has(`${r.personId}|${type}|${r.resourceId}`),
      inSodViolation:
        r.personId !== null &&
        sodKeys.has(`${r.personId}|${r.systemId}|${r.resourceKind}|${r.resourceId}`),
    };
  });

  if (scope.subjectCondition === undefined && scope.orgUnitIds === undefined) {
    return rows;
  }

  const users = await tx.user.findMany({
    where: { personId: { not: null } },
    select: { personId: true, orgUnitId: true },
  });
  const orgUnitByPerson = new Map(users.map((u) => [u.personId!, u.orgUnitId]));

  const contracts = await tx.contract.findMany({
    select: {
      personId: true,
      department: true,
      jobTitle: true,
      costCentre: true,
      employer: true,
      location: true,
      fte: true,
    },
  });
  const factsByPerson = new Map<string, ConditionFacts[]>();
  for (const c of contracts) {
    const facts: ConditionFacts = {
      'contract.department': c.department,
      'contract.jobTitle': c.jobTitle,
      'contract.costCentre': c.costCentre,
      'contract.employer': c.employer,
      'contract.location': c.location,
      // Prisma returns Decimal. The evaluator compares numerically and a
      // Decimal compared with `>` is a string comparison in disguise.
      'contract.fte': c.fte === null ? null : Number(c.fte),
      'person.status': null,
    };
    factsByPerson.set(c.personId, [...(factsByPerson.get(c.personId) ?? []), facts]);
  }

  return rows.filter((row) => {
    if (row.personId === null) {
      // An unattributed account satisfies no condition over contracts and sits
      // in no org unit. It is EXCLUDED from a conditioned scope rather than
      // silently admitted, and the campaign's coverage figure says how many
      // such accounts were in the systems it covered.
      return scope.subjectCondition === undefined && scope.orgUnitIds === undefined;
    }
    if (scope.orgUnitIds !== undefined) {
      const unit = orgUnitByPerson.get(row.personId) ?? null;
      if (unit === null || !scope.orgUnitIds.includes(unit)) return false;
    }
    if (scope.subjectCondition !== undefined) {
      const facts = factsByPerson.get(row.personId) ?? [];
      if (!facts.some((f) => evaluateCondition(scope.subjectCondition!, f))) return false;
    }
    return true;
  });
}

export interface ScopePreview {
  holdings: number;
  persons: number;
  systems: number;
  sample: { subjectKey: string; resourceName: string }[];
}

/**
 * "This scope covers 4,120 holdings across 1,180 persons and 6 systems — show
 * me." The screen that catches an unreviewable campaign before 200 people are
 * emailed, rather than at 3am on the due date.
 */
export async function previewCampaignScope(
  tenantId: string,
  /** `unknown` for the reason `createCampaign`'s does: the schema is the gate. */
  scope: unknown,
  snapshotId?: string,
): Promise<ScopePreview> {
  return withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, snapshotId);
    const rows = await holdingsInScope(tx, snapshot, campaignScopeSchema.parse(scope));
    return {
      holdings: rows.length,
      persons: new Set(rows.map((r) => r.personId).filter((p): p is string => p !== null)).size,
      systems: new Set(rows.map((r) => r.systemId)).size,
      sample: rows
        .slice(0, 25)
        .map((r) => ({ subjectKey: r.subjectKey, resourceName: r.resourceName })),
    };
  });
}

export async function createCampaign(
  tenantId: string,
  actorUserId: string | null,
  input: {
    name: string;
    description: string | null;
    /**
     * `unknown`, and parsed by `campaignScopeSchema` below.
     *
     * The SCHEMA is the authority — the three `MutuallyAssignable` guards above
     * exist to keep the type honest about it, not the other way round — and a
     * caller at the HTTP edge holds a zod-inferred value whose
     * `subjectCondition` is `unknown` by construction. Typing this as
     * `CampaignScope` bought a compile-time check for in-package callers at the
     * price of an `as never` at the only call site that matters, which Global
     * Constraint 12 forbids outside a Prisma `Json` write.
     */
    scope: unknown;
    reviewerSelector: string;
    reviewerConfig: Record<string, unknown>;
    fallbackSelector: string;
    fallbackConfig: Record<string, unknown>;
    ownerPersonId: string;
    opensAt: Date;
    dueAt: Date;
    allowBulkCertify: boolean;
    // `| undefined` on both: `exactOptionalPropertyTypes` is on
    // repo-wide and a zod-inferred optional is `T | undefined`.
    recurrence?: string | null | undefined;
    snapshotId?: string | undefined;
  },
): Promise<{ id: string }> {
  const scope = campaignScopeSchema.parse(input.scope);

  return withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const campaign = await tx.campaign.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description,
        scope: scope as never,
        snapshotId: snapshot.id,
        reviewerSelector: input.reviewerSelector,
        reviewerConfig: input.reviewerConfig as never,
        fallbackSelector: input.fallbackSelector,
        fallbackConfig: input.fallbackConfig as never,
        ownerPersonId: input.ownerPersonId,
        opensAt: input.opensAt,
        dueAt: input.dueAt,
        originalDueAt: input.dueAt,
        allowBulkCertify: input.allowBulkCertify,
        recurrence: input.recurrence ?? null,
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.create',
      targetType: 'Campaign',
      targetId: campaign.id,
      outcome: 'success',
      sourceIp: null,
      payload: { name: input.name, scope: scope as never, dueAt: input.dueAt.toISOString() },
    });
    return { id: campaign.id };
  });
}

/**
 * Generation is batched, the campaign stays `generating` until the last batch
 * commits, and `open` is set in a final short transaction. A campaign in
 * `generating` is invisible to reviewers, and NOBODY IS NOTIFIED until it is
 * open, so nobody opens a queue that is still filling.
 */
export async function startCampaign(
  tenantId: string,
  actorUserId: string | null,
  campaignId: string,
  options: {
    now?: Date;
    batchSize?: number;
    /**
     * The REVIEWER page size, separate from `batchSize`.
     *
     * `batchSize` bounds item creation, which is one `createMany` per page and
     * costs almost nothing per row; reviewer resolution does per-item work and
     * is the loop Global Constraint 4 is actually about. Without a seam the
     * only way to unbound it is to edit `REVIEWER_BATCH` itself, and a budget
     * constant no test can move is a budget constant no test can prove.
     */
    reviewerBatchSize?: number;
    publicUrl?: string;
  } = {},
): Promise<{ status: string; itemCount: number; blockedCount: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? ITEM_BATCH;
  const reviewerBatchSize = options.reviewerBatchSize ?? REVIEWER_BATCH;
  const publicUrl = options.publicUrl ?? '';

  const prepared = await withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (campaign.status !== 'draft') {
      throw new CampaignRefusedError(
        'not_draft',
        null,
        `this campaign is already ${campaign.status}`,
      );
    }

    const snapshot = await readableSnapshot(tx, campaign.snapshotId);
    const scope = campaignScopeSchema.parse(campaign.scope);
    const settings = await governSettings(tx);

    // Clock one: how long ago GOVERN assembled the picture.
    const age = checkSnapshotAge(snapshot.asOf, now, settings.maxSnapshotAgeDays);
    if (!age.ok) throw new CampaignRefusedError('stale_snapshot', age.clock, age.message);

    const rows = await holdingsInScope(tx, snapshot, scope);
    if (rows.length === 0) {
      throw new CampaignRefusedError(
        'empty_scope',
        null,
        'this scope covers no holdings at all; starting it would email reviewers about an empty queue',
      );
    }

    // Clock two: how long ago THE WORLD was read — and only for the sources
    // this scope actually depends on. Not every source in the tenant: a
    // campaign over Syntra roles must not be blocked by a target nobody has
    // read.
    const systemsInScope = new Set(rows.map((r) => r.systemId));
    const contributing = snapshot.sources.filter((s) => systemsInScope.has(s.sourceId));
    const freshness = checkSourceFreshness(contributing);
    if (!freshness.ok) {
      throw new CampaignRefusedError('stale_source', freshness.clock, freshness.message);
    }

    await tx.campaign.update({ where: { id: campaignId }, data: { status: 'generating' } });
    return { campaign, snapshot, rows };
  });

  let itemCount = 0;
  let blockedCount = 0;
  const reviewerCounts = new Map<string, number>();

  // TWO LOOPS, NOT ONE. Creating 500 items and then resolving reviewers for all
  // 500 in the SAME transaction costs a full `resolveStageApprovers` per item
  // inside one 5000 ms budget — and `REVIEWER_BATCH` would be a budget stored
  // and never read. Items are created first, in `ITEM_BATCH` transactions;
  // reviewers are resolved afterwards, in `REVIEWER_BATCH` transactions, over
  // the ids.

  // ---- create the items, ITEM_BATCH per transaction ------------------------
  for (let i = 0; i < prepared.rows.length; i += batchSize) {
    const batch = prepared.rows.slice(i, i + batchSize);
    await withTenant(tenantId, async (tx) => {
      // `createMany({ skipDuplicates: true })` against
      // `@@unique([campaignId, subjectKey, systemId, resourceKind, resourceId])`,
      // so a generation that crashed partway and was retried is idempotent
      // rather than duplicating every item it had already written. The campaign
      // has no `generating`-supersession path, and this is what stands in for
      // one.
      await tx.campaignItem.createMany({
        skipDuplicates: true,
        data: batch.map((row) => {
          const source = prepared.snapshot.sources.find((s) => s.sourceId === row.systemId);
          return {
            tenantId,
            campaignId,
            holdingSnapshotId: prepared.snapshot.id,
            subjectKey: row.subjectKey,
            personId: row.personId,
            accountRef: row.accountRef,
            systemId: row.systemId,
            resourceKind: row.resourceKind,
            resourceId: row.resourceId,
            resourceName: row.resourceName,
            // Copied, not referenced by id: editing the world afterwards must
            // not change what somebody attested to.
            attributions: row.attributions as never,
            observedAt: row.observedAt,
            coverageStatus: source?.completeness ?? 'complete',
            // ALL SIX flags are written HERE. `needs_review` and
            // `sod_violation` living in `HIGH_RISK_FLAGS` and in test fixtures
            // and in nothing production runs would mean bulk certify sweeps up
            // exactly the two items §12 says it must not — the mover, and the
            // person on both sides of a live SoD rule.
            riskFlags: [
              ...(row.privileged ? ['privileged'] : []),
              ...(row.unattributable ? ['unattributable'] : []),
              ...(source?.staleness === 'stale' ? ['stale'] : []),
              ...(row.attributions.some((a) => a.kind === 'auto_granted')
                ? ['no_human_decision']
                : []),
              ...(row.needsReview ? ['needs_review'] : []),
              ...(row.inSodViolation ? ['sod_violation'] : []),
            ],
          };
        }),
      });
    });
  }

  // ---- resolve reviewers, REVIEWER_BATCH items per transaction -------------
  //
  // Paged by id rather than by offset: `createdAt` defaults to `now()`, which
  // in PostgreSQL is TRANSACTION START TIME, so every row of one `createMany`
  // carries an identical `createdAt` and ordering by it imposes no order.
  let cursor: string | null = null;
  for (;;) {
    const page: { id: string }[] = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({
        where: { campaignId, ...(cursor === null ? {} : { id: { gt: cursor } }) },
        orderBy: { id: 'asc' },
        take: reviewerBatchSize,
        select: { id: true },
      }),
    );
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    itemCount += page.length;

    const outcome = await withTenant(tenantId, (tx) =>
      resolveItemReviewers(
        tx,
        campaignId,
        page.map((p) => p.id),
        now,
      ),
    );
    blockedCount += outcome.blocked;
    for (const [personId, count] of outcome.assignedByPerson) {
      reviewerCounts.set(personId, (reviewerCounts.get(personId) ?? 0) + count);
    }
  }

  // ---- open, and only now tell anybody -----------------------------------
  return withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.update({
      where: { id: campaignId },
      data: { status: 'open', totalItems: itemCount, blockedItems: blockedCount },
    });

    const recipients = await recipientsForPersons(tx, [...reviewerCounts.keys()]);
    const names = await displayNames(tx, { personIds: [campaign.ownerPersonId] });
    await enqueueOutbox(
      tx,
      recipients.map((recipient) => ({
        template: 'govern-review-assigned' as const,
        to: recipient.email,
        vars: {
          displayName: recipient.displayName,
          campaignName: campaign.name,
          itemCount: String(reviewerCounts.get(recipient.personId ?? '') ?? 0),
          dueAt: campaign.dueAt.toDateString(),
          reviewUrl: `${publicUrl}/govern/reviews?campaign=${campaignId}`,
        },
        requestId: null,
        userId: recipient.userId,
      })),
    );

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.start',
      targetType: 'Campaign',
      targetId: campaignId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        itemCount,
        blockedCount,
        reviewers: reviewerCounts.size,
        snapshotId: prepared.snapshot.id,
        ownerName: names.get(`person:${campaign.ownerPersonId}`) ?? null,
      },
    });

    return { status: 'open', itemCount, blockedCount };
  });
}

/**
 * A due date that can be moved quietly is not a due date. Extending is a
 * privileged, audited action recording who extended it and by how long, it
 * notifies every reviewer with open items, and the ORIGINAL date stays on the
 * row and in the evidence bundle beside the new one.
 */
export async function extendCampaign(
  tenantId: string,
  actorUserId: string | null,
  campaignId: string,
  newDueAt: Date,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (newDueAt <= campaign.dueAt) {
      throw new Error(
        'a due date may not move backwards; that would rewrite how long reviewers actually had',
      );
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: { dueAt: newDueAt, extensionCount: campaign.extensionCount + 1 },
    });

    const openItems = await tx.campaignItem.findMany({
      where: { campaignId, status: 'pending' },
      select: { reviewers: { where: { unassignedAt: null }, select: { personId: true } } },
    });
    const reviewerIds = [...new Set(openItems.flatMap((i) => i.reviewers.map((r) => r.personId)))];
    const recipients = await recipientsForPersons(tx, reviewerIds);
    await enqueueOutbox(
      tx,
      recipients.map((recipient) => ({
        template: 'govern-review-reminder' as const,
        to: recipient.email,
        vars: {
          displayName: recipient.displayName,
          campaignName: campaign.name,
          itemCount: String(openItems.length),
          dueAt: newDueAt.toDateString(),
          reviewUrl: `/govern/reviews?campaign=${campaignId}`,
        },
        requestId: null,
        userId: recipient.userId,
      })),
    );

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.extend',
      targetType: 'Campaign',
      targetId: campaignId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        originalDueAt: campaign.originalDueAt.toISOString(),
        previousDueAt: campaign.dueAt.toISOString(),
        newDueAt: newDueAt.toISOString(),
        extensionCount: campaign.extensionCount + 1,
        reviewersNotified: recipients.length,
      },
    });
  });
}

/**
 * Re-basing RE-OPENS ONLY THE ITEMS WHOSE HOLDING ACTUALLY CHANGED.
 *
 * A certification of a holding that has since changed is not a certification of
 * the current holding; a certification of one that has not is still good.
 * Re-opening everything would make a re-base a punishment for the reviewers who
 * answered on time.
 *
 * COMPOSITION HAZARD: this pairs with the `HoldingCertification` projection in
 * `decision-service.ts`. An item that is NOT re-opened must keep its projection
 * row; rolling the projection back for every item of a re-based campaign would
 * make a certification that is still good read as never made. So this function
 * never writes to `HoldingCertification` at all.
 */
export async function rebaseCampaign(
  tenantId: string,
  actorUserId: string | null,
  campaignId: string,
  newSnapshotId: string,
): Promise<{ reopened: number; kept: number }> {
  return withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const snapshot = await readableSnapshot(tx, newSnapshotId);
    const items = await tx.campaignItem.findMany({ where: { campaignId } });

    const fresh = await tx.holding.findMany({
      where: { snapshotId: snapshot.id, subjectKey: { in: items.map((i) => i.subjectKey) } },
      include: { attributions: { select: { kind: true, refId: true } } },
    });
    const byKey = new Map(
      fresh.map((h) => [`${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`, h]),
    );

    let reopened = 0;
    let kept = 0;

    for (const item of items) {
      const key = `${item.subjectKey}|${item.systemId}|${item.resourceKind}|${item.resourceId}`;
      const current = byKey.get(key);

      const before = (item.attributions as { kind: string; refId?: string | null }[]).map(
        (a) => `${a.kind}:${a.refId ?? ''}`,
      );
      const after = (current?.attributions ?? []).map((a) => `${a.kind}:${a.refId ?? ''}`);
      const changed =
        current === undefined ||
        current.state !== 'held' ||
        before.length !== after.length ||
        [...before].sort().join('|') !== [...after].sort().join('|');

      if (!changed) {
        kept += 1;
        continue;
      }
      reopened += 1;
      await tx.campaignItem.update({
        where: { id: item.id },
        data: {
          status: current === undefined ? 'moot' : 'pending',
          statusReason:
            current === undefined
              ? `the holding no longer exists as of snapshot ${snapshot.id}`
              : 'the holding changed between the original snapshot and the re-base',
          holdingSnapshotId: snapshot.id,
          attributions: (current?.attributions ?? []) as never,
          ...(current === undefined ? {} : { observedAt: current.observedAt }),
        },
      });
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: { snapshotId: snapshot.id, rebasedFromSnapshotId: campaign.snapshotId },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.campaign.rebase',
      targetType: 'Campaign',
      targetId: campaignId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        fromSnapshotId: campaign.snapshotId,
        toSnapshotId: snapshot.id,
        reopened,
        kept,
      },
    });

    return { reopened, kept };
  });
}
