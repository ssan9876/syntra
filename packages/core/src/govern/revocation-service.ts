import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { revokeGrant } from '../automate/fulfil.js';
import { LIVE_GRANT_STATUSES } from '../automate/types.js';
import { personDisplayName } from '../provision/desired.js';
import type { RevocationOrderFacts } from '../provision/types.js';
import { ROUTE_REMEDIATION_KIND, routeRevocation } from './dispatch.js';
import { createRemediationItem, upsertFindings, type FindingDraft } from './finding-service.js';
import { readableSnapshot } from './readable.js';
import { evaluateRevocationGuard } from './revocation-guard.js';
import { governSettings } from './settings-service.js';
import { countRegion, type ResourceKind, type Tri } from './types.js';

export class RevocationRefusedError extends Error {
  constructor(
    readonly code: 'blocked' | 'not_previewed' | 'confirmation_required',
    message: string,
  ) {
    super(message);
    this.name = 'RevocationRefusedError';
  }
}

/**
 * A reviewer clicking revoke has not revoked anything. What they have done is
 * record a decision — and this is the module that turns a set of decisions into
 * a batch somebody can look at, guard, and confirm.
 *
 * `computeRevocationBatch` opens ONE transaction for the whole batch: a batch
 * is thousands of rows at most, and Provision's rule applies at that size. It
 * supersedes a stale non-terminal batch at the head of it, and it never
 * auto-applies.
 */
export async function computeRevocationBatch(
  tenantId: string,
  actorUserId: string | null,
  campaignId: string,
  options: { now?: Date } = {},
): Promise<{
  batchId: string;
  status: string;
  requiresConfirmation: boolean;
  blockedReason: string | null;
}> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    // THE ESCAPE HATCH, in the same function as the index. A crashed compute
    // would otherwise brick every future batch for this campaign.
    const stale = await tx.revocationBatch.findFirst({
      where: { campaignId, status: { in: ['computing', 'previewed', 'blocked', 'applying'] } },
    });
    if (stale !== null) {
      await tx.revocationBatch.update({
        where: { id: stale.id },
        data: { status: 'superseded', finishedAt: now, error: 'superseded by a later batch' },
      });
    }

    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const snapshot = await readableSnapshot(tx, campaign.snapshotId);
    const settings = await governSettings(tx);

    const decided = await tx.campaignItem.findMany({
      where: { campaignId, status: 'revoke_decided' },
      orderBy: { resourceId: 'asc' },
    });

    const batch = await tx.revocationBatch.create({
      data: { tenantId, campaignId, status: 'computing', startedAt: now },
    });

    // LIVE grants only. A revoked, expired or handed-back grant contributing a
    // `grantIds` entry routes the holding to `automate_grant`, and
    // `confirmRevocationBatch` then calls `revokeGrant` on a dead grant — which
    // either errors on the irreversible path or succeeds as a no-op and reports
    // `revocation_dispatched` for a holding nothing removed.
    const grants = await tx.accessGrant.findMany({
      where: {
        subjectPersonId: {
          in: decided.map((d) => d.personId).filter((p): p is string => p !== null),
        },
        status: { in: [...LIVE_GRANT_STATUSES] },
      },
      select: { id: true, subjectPersonId: true, resourceId: true },
    });

    const dispatches = decided.map((item, index) => {
      const attributions = item.attributions as {
        kind: string;
        detail?: Record<string, unknown>;
      }[];
      const decision = routeRevocation({
        resourceKind: item.resourceKind as ResourceKind,
        systemKind: item.systemId === 'syntra' ? 'syntraInternal' : 'targetSystem',
        attributionKinds: attributions.map((a) => a.kind),
        // AN ENABLED BUSINESS RULE, AND NOTHING ELSE. Including the grant kinds
        // here makes a holding with a DISABLED rule plus a live grant route to
        // `requires_change_rule` — "Provision would grant it back tonight",
        // about a rule that is switched off — so the grant, the only live
        // cause, is never revoked and a `rule_change_required` remediation item
        // is filed against a disabled rule. That is the mover shape: the
        // birthright rule was turned off when the person changed job.
        //
        // The broader "any live rule OR grant" test §5 requires is a DIFFERENT
        // question and lives on `createRevocationOrder`'s `liveAttribution`.
        liveRuleAttribution: attributions.some(
          (a) => a.kind === 'business_rule' && a.detail?.['ruleEnabled'] === true,
        ),
        grantIds: grants
          .filter((g) => g.subjectPersonId === item.personId && g.resourceId === item.resourceId)
          .map((g) => g.id),
        directorySourceId:
          (attributions.find((a) => a.kind === 'directory_source')?.detail?.['sourceId'] as
            | string
            | undefined) ?? null,
      });
      return { item, decision, index };
    });

    const revocationsByResource = new Map<string, number>();
    const resourceNameById = new Map<string, string>();
    for (const { item, decision } of dispatches) {
      if (!decision.dispatchable) continue;
      revocationsByResource.set(
        item.resourceId,
        (revocationsByResource.get(item.resourceId) ?? 0) + 1,
      );
      resourceNameById.set(item.resourceId, item.resourceName);
    }

    // There is NO holder count for anything but a target entitlement anywhere
    // in the platform, so the denominator comes from this campaign's OWN
    // snapshot, and a resource sitting behind a coverage gap answers `unknown`
    // rather than a confident number.
    //
    // TWO GROUPED QUERIES, NOT TWO PER RESOURCE. A batch spanning 200 resources
    // would otherwise be 400 extra round trips inside the one transaction §19
    // sizes at "thousands of rows at most".
    const resourceIds = [...revocationsByResource.keys()];
    const holderRows =
      resourceIds.length === 0
        ? []
        : await tx.holding.groupBy({
            by: ['resourceId'],
            where: { snapshotId: snapshot.id, resourceId: { in: resourceIds }, state: 'held' },
            _count: { _all: true },
          });
    const heldByResource = new Map(holderRows.map((r) => [r.resourceId, r._count._all]));

    const gapRows = await tx.coverageGap.findMany({
      where: {
        snapshotId: snapshot.id,
        OR: [{ resourceId: { in: resourceIds } }, { resourceId: null }],
      },
      select: { resourceId: true, reason: true },
    });
    // A gap with a null `resourceId` is a whole region nobody read, so it
    // applies to every resource in the batch.
    const tenantWideGapReasons = gapRows.filter((g) => g.resourceId === null).map((g) => g.reason);
    const gapReasonsByResource = new Map<string, string[]>();
    for (const gap of gapRows) {
      if (gap.resourceId === null) continue;
      gapReasonsByResource.set(gap.resourceId, [
        ...(gapReasonsByResource.get(gap.resourceId) ?? []),
        gap.reason,
      ]);
    }

    const holderCountByResource = new Map<string, Tri<number>>();
    for (const resourceId of resourceIds) {
      holderCountByResource.set(
        resourceId,
        countRegion({
          held: heldByResource.get(resourceId) ?? 0,
          unknownHoldings: 0,
          gapReasons: [...tenantWideGapReasons, ...(gapReasonsByResource.get(resourceId) ?? [])],
        }),
      );
    }

    const inScope = await tx.campaignItem.count({ where: { campaignId } });
    const verdict = evaluateRevocationGuard({
      revocationsInBatch: dispatches.filter((d) => d.decision.dispatchable).length,
      holdingsInScope: inScope,
      revocationsByResource,
      holderCountByResource,
      resourceNameById,
      thresholds: {
        batchThresholdPercent: settings.batchThresholdPercent,
        perResourceThresholdPercent: settings.perResourceThresholdPercent,
        personPopulationDropPercent: settings.personPopulationDropPercent,
      },
      snapshotAgeDays: Math.floor((now.getTime() - snapshot.asOf.getTime()) / 86_400_000),
      maxSnapshotAgeDays: settings.maxSnapshotAgeDays,
      staleSources: snapshot.sources.map((s) => ({
        sourceName: s.sourceName,
        staleness: s.staleness,
        completeness: s.completeness,
      })),
      personsWithActiveContract: snapshot.personsWithActiveContract,
      previousPersonsWithActiveContract: settings.personsWithActiveContractAtLastBatch,
      hasEverApplied: settings.lastAppliedBatchAt !== null,
    });

    await tx.revocationDispatch.createMany({
      data: dispatches.map(({ item, decision, index }) => ({
        tenantId,
        batchId: batch.id,
        itemId: item.id,
        holdingDescriptor: {
          subjectKey: item.subjectKey,
          systemId: item.systemId,
          resourceKind: item.resourceKind,
          resourceId: item.resourceId,
          resourceName: item.resourceName,
          explanation: decision.explanation,
          notRemoved: decision.notRemoved,
        } as never,
        route: decision.route,
        // EVERY row is `proposed` at compute time, dispatchable or not
        // (Ruling G-43). `revocation_dispatch_requires_change_has_item` requires
        // a `remediationItemId` on any `requires_change` row, and that item
        // does not exist until the batch is CONFIRMED — a `requires_change` row
        // with no remediation item is a row saying somebody must change
        // something with nobody named to do it. The route already distinguishes
        // the two, and the route is what `confirmRevocationBatch` switches on.
        status: 'proposed',
        // An explicit ordinal: createdAt is transaction start time and every
        // row of this createMany carries an identical one.
        sequence: index,
      })),
    });

    const status = verdict.outcome === 'refused' ? 'blocked' : 'previewed';
    await tx.revocationBatch.update({
      where: { id: batch.id },
      data: {
        status,
        proposedCount: dispatches.filter((d) => d.decision.dispatchable).length,
        requiresChangeCount: dispatches.filter((d) => !d.decision.dispatchable).length,
        requiresConfirmation: verdict.outcome === 'requires_confirmation',
        blockedReason: verdict.outcome === 'proceed' ? null : verdict.reasons.join('; '),
      },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.revocation.compute',
      targetType: 'RevocationBatch',
      targetId: batch.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        campaignId,
        status,
        verdict: verdict.outcome,
        reasons: verdict.outcome === 'proceed' ? [] : verdict.reasons,
        supersededBatchId: stale?.id ?? null,
      },
    });

    return {
      batchId: batch.id,
      status,
      requiresConfirmation: verdict.outcome === 'requires_confirmation',
      blockedReason: verdict.outcome === 'proceed' ? null : verdict.reasons.join('; '),
    };
  });
}

/** A per-row decision not to dispatch. It survives the confirmation. */
export async function skipDispatch(
  tenantId: string,
  actorUserId: string | null,
  dispatchId: string,
  reason: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.revocationDispatch.update({
      where: { id: dispatchId },
      data: { status: 'skipped', message: reason },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.revocation.skip',
      targetType: 'RevocationDispatch',
      targetId: dispatchId,
      outcome: 'success',
      sourceIp: null,
      payload: { reason },
    });
  });
}

/**
 * Ruling G1's three constraints, plus its condition.
 *
 * Constraint one is the refusal below: an order may not be created for a
 * holding a rule or a live grant still wants. If a rule wants it, the honest
 * answer is to change the rule, and that is the remediation item, not the
 * order.
 */
async function createRevocationOrder(
  tx: TenantClient,
  tenantId: string,
  input: {
    targetSystemId: string;
    accountId: string;
    entitlementId: string;
    decidedByPersonId: string;
    decidedByPersonName: string;
    campaignName: string | null;
    campaignDecisionId: string | null;
    reason: string;
    liveAttribution: boolean;
  },
): Promise<string> {
  if (input.liveAttribution) {
    throw new Error(
      'a revocation order may not be created for a holding a rule or a live grant still wants',
    );
  }
  // The escape hatch for `govern_revocation_order_one_open`: an existing open
  // order for this holding is cancelled, not collided with.
  await tx.revocationOrder.updateMany({
    where: {
      targetSystemId: input.targetSystemId,
      accountId: input.accountId,
      entitlementId: input.entitlementId,
      status: 'open',
    },
    data: { status: 'cancelled', cancelledReason: 'superseded by a later decision' },
  });

  // DESTRUCTURE, NEVER SPREAD A MIXED CONTROL/DATA OBJECT INTO A PRISMA `data`.
  // `liveAttribution` is a control flag, not a column, and TypeScript does not
  // apply excess-property checking to SPREAD properties — so `{ ...input }`
  // compiles cleanly and throws `PrismaClientValidationError: Unknown argument
  // 'liveAttribution'` at runtime, on every revocation order, on the
  // irreversible path.
  const { liveAttribution: _liveAttribution, ...columns } = input;
  const order = await tx.revocationOrder.create({
    data: { tenantId, ...columns, status: 'open' },
  });
  return order.id;
}

/**
 * The function that performs the irreversible act.
 *
 * Four things about it are load-bearing:
 *
 * 1. It RE-READS the guard against current settings before dispatching, not the
 *    verdict stored at compute time. §13 refuses again at execution: a batch
 *    computed at 09:00 and confirmed at 17:00 may be a different act.
 * 2. ONE SHORT TRANSACTION PER DISPATCH ROW, each alongside its audit event.
 *    `revokeGrant` opens its own transaction, so it is called OUTSIDE this
 *    module's, never inside one.
 * 3. A deciding person with no active `User` dispatches with a null actor and
 *    records that fact on the row. A missing account is a recorded message,
 *    never a dropped revocation.
 * 4. The final transaction writes `lastAppliedBatchAt` and
 *    `personsWithActiveContractAtLastBatch` — the two columns §13's
 *    person-population-collapse refusal reads. Without them the guard is
 *    present, reachable, reads a value nobody wrote, and always passes.
 */
export async function confirmRevocationBatch(
  tenantId: string,
  actorUserId: string,
  batchId: string,
  options: { now?: Date; confirmed?: boolean } = {},
): Promise<{ status: string; dispatched: number; requiresChange: number; failed: number }> {
  const now = options.now ?? new Date();

  // ---- refuse, before anything is dispatched -------------------------------
  const prepared = await withTenant(tenantId, async (tx) => {
    const batch = await tx.revocationBatch.findUniqueOrThrow({ where: { id: batchId } });

    // A `blocked` batch has no confirmation. §13's outright conditions are the
    // ones "no confirmation can fix", and offering a confirm button for them
    // would make them advisory.
    if (batch.status === 'blocked') {
      throw new RevocationRefusedError(
        'blocked',
        `this batch is blocked and cannot be confirmed: ${batch.blockedReason ?? 'no reason recorded'}`,
      );
    }
    if (batch.status !== 'previewed') {
      throw new RevocationRefusedError('not_previewed', `this batch is ${batch.status}`);
    }
    // `requiresConfirmation` needs an EXPLICIT confirmation from the caller.
    // Defaulting it to true would make the second axis of §13's guard a
    // formality that every caller passes by not thinking about it.
    if (batch.requiresConfirmation && options.confirmed !== true) {
      throw new RevocationRefusedError(
        'confirmation_required',
        `this batch requires an explicit confirmation: ${batch.blockedReason ?? ''}`,
      );
    }

    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: batch.campaignId } });
    const snapshot = await readableSnapshot(tx, campaign.snapshotId);
    const settings = await governSettings(tx);

    // RE-READ THE GUARD AGAINST CURRENT SETTINGS AND THE CURRENT CLOCK. The
    // verdict stored at compute time is a report, not a permission.
    const reguard = evaluateRevocationGuard({
      revocationsInBatch: batch.proposedCount,
      holdingsInScope: await tx.campaignItem.count({ where: { campaignId: campaign.id } }),
      revocationsByResource: new Map(),
      holderCountByResource: new Map(),
      resourceNameById: new Map(),
      thresholds: {
        batchThresholdPercent: settings.batchThresholdPercent,
        perResourceThresholdPercent: settings.perResourceThresholdPercent,
        personPopulationDropPercent: settings.personPopulationDropPercent,
      },
      snapshotAgeDays: Math.floor((now.getTime() - snapshot.asOf.getTime()) / 86_400_000),
      maxSnapshotAgeDays: settings.maxSnapshotAgeDays,
      staleSources: snapshot.sources.map((s) => ({
        sourceName: s.sourceName,
        staleness: s.staleness,
        completeness: s.completeness,
      })),
      personsWithActiveContract: snapshot.personsWithActiveContract,
      previousPersonsWithActiveContract: settings.personsWithActiveContractAtLastBatch,
      hasEverApplied: settings.lastAppliedBatchAt !== null,
    });
    if (reguard.outcome === 'refused') {
      await tx.revocationBatch.update({
        where: { id: batchId },
        data: { status: 'blocked', blockedReason: reguard.reasons.join('; ') },
      });
      throw new RevocationRefusedError(
        'blocked',
        `this batch is refused at execution: ${reguard.reasons.join('; ')}`,
      );
    }

    await tx.revocationBatch.update({
      where: { id: batchId },
      data: { status: 'applying', confirmedByUserId: actorUserId },
    });

    const rows = await tx.revocationDispatch.findMany({
      // `skipped` rows are excluded: a per-row skip is a decision and this must
      // not undo it. `cancelled` likewise.
      where: { batchId, status: 'proposed' },
      orderBy: { sequence: 'asc' },
    });

    return {
      rows,
      campaignName: campaign.name,
      campaignOwnerPersonId: campaign.ownerPersonId,
      personsWithActiveContract: snapshot.personsWithActiveContract,
    };
  });

  let dispatched = 0;
  let requiresChange = 0;
  let failed = 0;

  // ---- one short transaction per row, alongside its audit event ------------
  for (const row of prepared.rows) {
    const descriptor = row.holdingDescriptor as {
      subjectKey?: string;
      systemId?: string;
      resourceKind?: string;
      resourceId?: string;
      resourceName?: string;
      explanation?: string;
      notRemoved?: string[];
    };

    // The deciding PERSON and the account they decided from. `revokeGrant`
    // takes a `User` id and a reviewer decides as a `Person` who may hold
    // several accounts or none, so re-resolving here would pick an arbitrary
    // one. `CampaignDecision.decidedByUserId` records the account the decision
    // was actually made from.
    const decision = await withTenant(tenantId, async (tx) => {
      if (row.itemId === null) return null;
      return tx.campaignDecision.findFirst({
        where: { itemId: row.itemId, decision: 'revoke' },
        orderBy: { decidedAt: 'desc' },
        select: { id: true, personId: true, decidedByUserId: true, comment: true },
      });
    });

    // An ACTIVE user, re-checked now. A `decidedByUserId` naming an account
    // that has since been deactivated is not an actor.
    const deciderUserId = await withTenant(tenantId, async (tx) => {
      if (decision?.decidedByUserId == null) return null;
      const user = await tx.user.findFirst({
        where: { id: decision.decidedByUserId, status: 'active' },
        select: { id: true },
      });
      return user?.id ?? null;
    });
    const noAccountNote =
      decision !== null && deciderUserId === null
        ? 'the deciding person holds no active Syntra account, so this was dispatched with no actor recorded against it'
        : null;

    const reason = `${prepared.campaignName}: ${decision?.comment ?? 'revoked by decision'}`;

    try {
      if (row.route === 'automate_grant') {
        // `revokeGrant` OPENS ITS OWN TRANSACTION, so it is called outside this
        // module's. Automate's single-grant hand-back exemption is deliberately
        // NOT in this path: §13 says Govern's batch guard is what makes the
        // aggregate safe, and a reviewer's 340 decisions arriving at once are
        // mass action wearing 340 individual coats.
        const grantId = await withTenant(tenantId, async (tx) => {
          if (row.itemId === null) return null;
          const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: row.itemId } });
          if (item.personId === null) return null;
          const grant = await tx.accessGrant.findFirst({
            where: {
              subjectPersonId: item.personId,
              resourceId: descriptor.resourceId ?? '',
              status: { in: [...LIVE_GRANT_STATUSES] },
            },
            select: { id: true },
          });
          return grant?.id ?? null;
        });

        if (grantId === null) {
          // The grant died between compute and confirm. That is not a failure
          // and it is not a success: the holding may already be gone, and the
          // next snapshot decides. It is recorded in words.
          await withTenant(tenantId, async (tx) => {
            await tx.revocationDispatch.update({
              where: { id: row.id },
              data: {
                status: 'failed',
                message:
                  'the grant behind this holding was already ended between the preview and the confirmation; nothing was dispatched',
              },
            });
            await recordEvent(tx, {
              actorUserId,
              action: 'govern.revocation.dispatch',
              targetType: 'RevocationDispatch',
              targetId: row.id,
              outcome: 'failure',
              sourceIp: null,
              payload: { route: row.route, reason: 'grant_already_ended' },
            });
          });
          failed += 1;
          continue;
        }

        await revokeGrant(tenantId, deciderUserId ?? actorUserId, grantId, reason);

        await withTenant(tenantId, async (tx) => {
          await tx.revocationDispatch.update({
            where: { id: row.id },
            data: {
              status: 'dispatched',
              dispatchedAt: now,
              grantId,
              ...(noAccountNote === null ? {} : { message: noAccountNote }),
            },
          });
          if (row.itemId !== null) {
            await tx.campaignItem.update({
              where: { id: row.itemId },
              data: { status: 'revocation_dispatched' },
            });
          }
          await recordEvent(tx, {
            actorUserId,
            action: 'govern.revocation.dispatch',
            targetType: 'RevocationDispatch',
            targetId: row.id,
            outcome: 'success',
            sourceIp: null,
            payload: {
              route: row.route,
              grantId,
              batchId,
              decidedByPersonId: decision?.personId ?? null,
              actedAs: deciderUserId,
              note: noAccountNote,
            },
          });
        });
        dispatched += 1;
        continue;
      }

      if (row.route === 'revocation_order') {
        await withTenant(tenantId, async (tx) => {
          const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: row.itemId! } });
          const person =
            decision === null
              ? null
              : await tx.person.findUniqueOrThrow({ where: { id: decision.personId } });
          const account = await tx.targetAccount.findFirstOrThrow({
            where: {
              targetSystemId: item.systemId,
              ...(item.personId === null ? {} : { personId: item.personId }),
            },
            select: { id: true },
          });

          // `liveAttribution` is derived from the item's attribution set AT
          // DISPATCH TIME, not at compute time. Between the preview and the
          // confirmation somebody may have enabled a rule that wants this
          // holding, and `createRevocationOrder` refuses in that case — which
          // is Ruling G1's first constraint and the whole reason the parameter
          // exists.
          const attributions = item.attributions as {
            kind: string;
            detail?: Record<string, unknown>;
          }[];
          const liveAttribution = attributions.some(
            (a) =>
              (a.kind === 'business_rule' && a.detail?.['ruleEnabled'] === true) ||
              a.kind === 'request' ||
              a.kind === 'delegated_admin' ||
              a.kind === 'auto_granted',
          );

          const orderId = await createRevocationOrder(tx, tenantId, {
            targetSystemId: item.systemId,
            accountId: account.id,
            entitlementId: item.resourceId,
            decidedByPersonId: decision?.personId ?? '',
            decidedByPersonName: person === null ? 'an unnamed reviewer' : personDisplayName(person),
            campaignName: prepared.campaignName,
            campaignDecisionId: decision?.id ?? null,
            reason,
            liveAttribution,
          });

          await tx.revocationDispatch.update({
            where: { id: row.id },
            data: {
              status: 'dispatched',
              dispatchedAt: now,
              revocationOrderId: orderId,
              ...(noAccountNote === null ? {} : { message: noAccountNote }),
            },
          });
          await tx.campaignItem.update({
            where: { id: row.itemId! },
            data: { status: 'revocation_dispatched' },
          });
          await recordEvent(tx, {
            actorUserId,
            action: 'govern.revocation.dispatch',
            targetType: 'RevocationDispatch',
            targetId: row.id,
            outcome: 'success',
            sourceIp: null,
            payload: {
              route: row.route,
              revocationOrderId: orderId,
              batchId,
              decidedByPersonId: decision?.personId ?? null,
              actedAs: deciderUserId,
              note: noAccountNote,
            },
          });
        });
        dispatched += 1;
        continue;
      }

      // The four `requires_change` routes. NOT REVOCATIONS, and no report calls
      // them one: the item goes to `revocation_requires_change`, a
      // `RemediationItem` is created naming what has to change and who owns it,
      // and the vocabulary rule keeps it out of every revoked figure.
      await withTenant(tenantId, async (tx) => {
        const remediationId = await createRemediationItem(tx, tenantId, {
          kind: ROUTE_REMEDIATION_KIND[row.route as never] ?? 'direct_assignment_change_required',
          ownerPersonId: prepared.campaignOwnerPersonId,
          dueAt: new Date(now.getTime() + 14 * 86_400_000),
          ...(row.itemId === null ? {} : { campaignItemId: row.itemId }),
          description:
            `${descriptor.resourceName ?? 'this holding'} for ${descriptor.subjectKey ?? 'a subject'}: ` +
            `${descriptor.explanation ?? 'Govern cannot execute this removal.'}` +
            (descriptor.notRemoved?.length
              ? ` Attributions that were NOT removed: ${descriptor.notRemoved.join(', ')}.`
              : ''),
          deepLink: `/admin/govern/batches/${batchId}`,
        });

        await tx.revocationDispatch.update({
          where: { id: row.id },
          data: {
            status: 'requires_change',
            // The CHECK `revocation_dispatch_requires_change_has_item` requires
            // this, and a null here would abort the transaction.
            remediationItemId: remediationId,
            message: descriptor.explanation ?? null,
          },
        });
        if (row.itemId !== null) {
          await tx.campaignItem.update({
            where: { id: row.itemId },
            data: {
              status: 'revocation_requires_change',
              statusReason: descriptor.explanation ?? null,
            },
          });
        }
        await recordEvent(tx, {
          actorUserId,
          action: 'govern.revocation.requires_change',
          targetType: 'RevocationDispatch',
          targetId: row.id,
          outcome: 'success',
          sourceIp: null,
          payload: { route: row.route, remediationItemId: remediationId, batchId },
        });
      });
      requiresChange += 1;
    } catch (error) {
      // NOT SWALLOWED. The failure is recorded on the row, with its message,
      // and the loop continues so one target being down does not abandon the
      // other 339 rows.
      const message = error instanceof Error ? error.message : String(error);
      await withTenant(tenantId, async (tx) => {
        await tx.revocationDispatch.update({
          where: { id: row.id },
          data: { status: 'failed', message },
        });
        if (row.itemId !== null) {
          await tx.campaignItem.update({
            where: { id: row.itemId },
            data: { status: 'revocation_failed', statusReason: message },
          });
        }
        await recordEvent(tx, {
          actorUserId,
          action: 'govern.revocation.dispatch',
          targetType: 'RevocationDispatch',
          targetId: row.id,
          outcome: 'failure',
          sourceIp: null,
          payload: { route: row.route, batchId, error: message },
        });
      });
      failed += 1;
    }
  }

  // ---- close the batch AND write the denominator --------------------------
  const status = failed > 0 ? 'partially_applied' : 'applied';
  await withTenant(tenantId, async (tx) => {
    await tx.revocationBatch.update({
      where: { id: batchId },
      data: {
        status,
        finishedAt: now,
        dispatchedCount: dispatched,
        requiresChangeCount: requiresChange,
        failedCount: failed,
      },
    });

    // THE TWO COLUMNS NOBODY WOULD OTHERWISE WRITE.
    //
    // `personsWithActiveContractAtLastBatch` is the denominator §13's
    // person-population-collapse refusal compares against, and
    // `lastAppliedBatchAt` is how the guard knows a batch has ever been
    // applied. Without these writes the first stays `null` forever, the guard's
    // `previousPersonsWithActiveContract !== null && > 0` condition never
    // holds, and the refusal whose stated failure is "a truncated HR import
    // makes everybody look like a leaver, and a campaign running over that data
    // revokes the organization" NEVER FIRES.
    //
    // Stored rather than recomputed, for the reason Provision stores
    // `lastAppliedRunAt`: the comparison is against the last state SOMEBODY
    // ACCEPTED, not the last state observed.
    await tx.governSettings.update({
      where: { tenantId },
      data: {
        lastAppliedBatchAt: now,
        personsWithActiveContractAtLastBatch: prepared.personsWithActiveContract,
      },
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.revocation.confirm',
      targetType: 'RevocationBatch',
      targetId: batchId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        status,
        dispatched,
        requiresChange,
        failed,
        personsWithActiveContractAtLastBatch: prepared.personsWithActiveContract,
      },
    });
  });

  return { status, dispatched, requiresChange, failed };
}

/**
 * The vocabulary rule, enforced.
 *
 * `confirmed` → the owning subsystem reported the removal applied, and no
 * snapshot has been built since.
 *
 * `applied` → confirmed AND a subsequent snapshot no longer shows the holding.
 * TWO CONDITIONS, NOT ONE, because a write that reported success and did not
 * land is a case Provision's convergence logic exists for and Govern should not
 * be more credulous than Provision is.
 *
 * A dispatch that is `confirmed` but whose next snapshot STILL SHOWS the
 * holding does not advance: it raises a `dispatch_not_applied` finding naming
 * both facts.
 */
export async function reflectRevocationOutcomes(
  tenantId: string,
  snapshotId: string,
  options: { now?: Date } = {},
): Promise<{ confirmed: number; applied: number; notApplied: number; slaBreaches: number }> {
  const now = options.now ?? new Date();
  let confirmed = 0;
  let applied = 0;
  let notApplied = 0;
  let slaBreaches = 0;
  const findings: FindingDraft[] = [];

  const settings = await withTenant(tenantId, (tx) => governSettings(tx));

  // ---- dispatched -> confirmed -------------------------------------------
  const dispatched = await withTenant(tenantId, (tx) =>
    tx.revocationDispatch.findMany({
      // `cancelled` is EXCLUDED here and from the SLA sweep. Composing the
      // cancelled-as-overtaken order with the SLA finding the naive way raises
      // a finding saying a revocation was not applied, about a revocation that
      // was correctly abandoned.
      where: { status: 'dispatched' },
      select: {
        id: true,
        grantId: true,
        revocationOrderId: true,
        dispatchedAt: true,
        holdingDescriptor: true,
        batchId: true,
      },
    }),
  );

  for (const dispatch of dispatched) {
    const owningSubsystemReportedApplied = await withTenant(tenantId, async (tx) => {
      if (dispatch.revocationOrderId !== null) {
        const action = await tx.provisionAction.findFirst({
          where: { revocationOrderId: dispatch.revocationOrderId, status: 'applied' },
          select: { id: true },
        });
        return action !== null;
      }
      if (dispatch.grantId !== null) {
        const grant = await tx.accessGrant.findUnique({
          where: { id: dispatch.grantId },
          select: { status: true },
        });
        return grant?.status === 'revoked';
      }
      return false;
    });

    if (owningSubsystemReportedApplied) {
      await withTenant(tenantId, (tx) =>
        tx.revocationDispatch.update({
          where: { id: dispatch.id },
          data: { status: 'confirmed', confirmedAt: now },
        }),
      );
      confirmed += 1;
      continue;
    }

    // The clock measures to CONFIRMATION rather than to observation,
    // deliberately: observation waits on the next snapshot, and an SLA that
    // fired because a nightly job had not run yet would be an alert that trains
    // people to ignore alerts.
    const ageHours =
      dispatch.dispatchedAt === null
        ? 0
        : (now.getTime() - dispatch.dispatchedAt.getTime()) / 3_600_000;
    if (ageHours > settings.dispatchSlaHours) {
      slaBreaches += 1;
      findings.push({
        kind: 'dispatch_not_applied',
        severity: 'high',
        subjectRefType: 'dispatch',
        subjectRefId: dispatch.id,
        detail: {
          ...(dispatch.holdingDescriptor as Record<string, unknown>),
          dispatchedAt: dispatch.dispatchedAt?.toISOString() ?? null,
          ageHours: Math.round(ageHours),
          dispatchSlaHours: settings.dispatchSlaHours,
          statement:
            'this revocation was dispatched and the owning subsystem has not reported it applied within its SLA',
        },
      });
    }
  }

  // ---- confirmed -> applied, or a finding ---------------------------------
  const awaitingObservation = await withTenant(tenantId, (tx) =>
    tx.revocationDispatch.findMany({
      where: { status: 'confirmed' },
      select: { id: true, holdingDescriptor: true, confirmedAt: true },
    }),
  );

  for (const dispatch of awaitingObservation) {
    const descriptor = dispatch.holdingDescriptor as {
      subjectKey?: string;
      systemId?: string;
      resourceKind?: string;
      resourceId?: string;
    };
    const stillThere = await withTenant(tenantId, (tx) =>
      tx.holding.findFirst({
        where: {
          snapshotId,
          subjectKey: descriptor.subjectKey ?? '',
          systemId: descriptor.systemId ?? '',
          resourceKind: descriptor.resourceKind ?? '',
          resourceId: descriptor.resourceId ?? '',
          state: 'held',
        },
        select: { id: true },
      }),
    );

    if (stillThere === null) {
      // TWO CONDITIONS, NOT ONE: confirmed AND observed gone.
      await withTenant(tenantId, (tx) =>
        tx.revocationDispatch.update({
          where: { id: dispatch.id },
          data: { status: 'applied', appliedAt: now },
        }),
      );
      applied += 1;
      continue;
    }

    // It does NOT advance. One of the more valuable rows this subsystem
    // produces: the owning subsystem says it removed this and the next snapshot
    // still shows it held.
    notApplied += 1;
    findings.push({
      kind: 'dispatch_not_applied',
      severity: 'high',
      subjectRefType: 'dispatch',
      subjectRefId: dispatch.id,
      detail: {
        ...descriptor,
        confirmedAt: dispatch.confirmedAt?.toISOString() ?? null,
        observedInSnapshotId: snapshotId,
        statement:
          'the owning subsystem reported this removal applied, and the next snapshot still shows the holding as held',
      },
    });
  }

  if (findings.length > 0) {
    // `upsertFindings`, never `reconcileFindings`: this caller computes only
    // `dispatch_not_applied` drafts, and a whole-tenant sweep from here would
    // close every other open finding in the tenant.
    await upsertFindings(tenantId, findings, { now });
  }

  // ---- roll the outcomes back onto the campaign items ---------------------
  // PAGED, one transaction per page.
  const REFLECT_BATCH = 200;
  let cursor: string | null = null;
  for (;;) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findMany({
        where: {
          itemId: { not: null },
          status: { in: ['confirmed', 'applied', 'failed'] },
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        select: { id: true, itemId: true, status: true, message: true },
        orderBy: { id: 'asc' },
        take: REFLECT_BATCH,
      }),
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    await withTenant(tenantId, async (tx) => {
      for (const row of rows) {
        await tx.campaignItem.update({
          where: { id: row.itemId! },
          data: {
            status:
              row.status === 'applied'
                ? 'revocation_applied'
                : row.status === 'failed'
                  ? 'revocation_failed'
                  : 'revocation_confirmed',
            ...(row.message === null ? {} : { statusReason: row.message }),
          },
        });
      }
    });
  }

  return { confirmed, applied, notApplied, slaBreaches };
}

/**
 * The open orders for one target, as PLAIN VALUES for Provision's plan stage.
 *
 * Provision never queries Govern: it is handed this array and consumes it. The
 * three provenance fields are denormalised so the audit event written when the
 * action is applied can name a human, a campaign and a decision — Ruling G1's
 * condition, without which the ruling does not hold.
 */
export async function loadRevocationOrders(
  tx: TenantClient,
  targetSystemId: string,
): Promise<RevocationOrderFacts[]> {
  const orders = await tx.revocationOrder.findMany({
    where: { targetSystemId, status: 'open' },
    orderBy: { createdAt: 'asc' },
  });
  return orders.map((order) => ({
    orderId: order.id,
    accountId: order.accountId,
    entitlementId: order.entitlementId,
    decidedByPersonName: order.decidedByPersonName,
    campaignName: order.campaignName,
    campaignDecisionId: order.campaignDecisionId,
    reason: order.reason,
  }));
}
