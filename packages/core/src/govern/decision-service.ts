import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { isValidApprover } from '../automate/approvers.js';
import { governSettings } from './settings-service.js';
import { parseSubjectKey } from './types.js';

/**
 * Decisions on campaign items: certify, revoke, and the bulk action with its
 * carve-outs.
 *
 * **No transition into `certified` exists that is not caused by a
 * `CampaignDecision` row.** That is the whole point of the module, and it is
 * asserted structurally rather than written down: see `CERTIFYING_TRANSITIONS`
 * and `DECISION_ENTRY_POINTS` below, and the tests over both.
 *
 * The exported names carry the `Campaign` prefix because `packages/core` has a
 * flat `export *` barrel and Automate's approval decisions already own
 * `recordDecision`, `DecisionInput` and `DecisionRefusedError` in it. Two
 * different decisions with one name is a support call nobody can close, and
 * the barrel would refuse to build besides (Ruling G-36).
 */

/**
 * THE STRUCTURAL RULE, as data.
 *
 * There is no status that means "certified because time ran out", and this
 * constant is what a test asserts over. Adding a negative-confirmation setting
 * later means adding a row here with a `causedBy` that is not
 * `'CampaignDecision'` — which fails a test rather than passing review.
 */
export const CERTIFYING_TRANSITIONS: readonly {
  from: string;
  to: 'certified';
  causedBy: 'CampaignDecision';
}[] = [{ from: 'pending', to: 'certified', causedBy: 'CampaignDecision' }];

/**
 * The exhaustive list of FILES that may write `status = 'certified'`.
 *
 * Widening it is a deliberate edit to the module that owns the rule, which is
 * the point — Automate's `APPROVED_ENTRY_POINTS`, for attestation.
 */
export const DECISION_ENTRY_POINTS: readonly string[] = ['decision-service.ts'];

export type CampaignDecisionRefusalCode =
  | 'not_reviewer'
  | 'reviewer_invalid'
  | 'self_review'
  | 'subject_departed'
  | 'item_not_pending'
  | 'campaign_not_open'
  | 'comment_required'
  | 'bulk_not_allowed'
  | 'bulk_too_large'
  | 'high_risk_not_bulkable';

export class CampaignDecisionRefusedError extends Error {
  constructor(
    readonly code: CampaignDecisionRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignDecisionRefusedError';
  }
}

/**
 * Refused outright from a bulk action, and decided one at a time with a
 * mandatory comment.
 *
 * `needs_review` is Automate's mover flag — the person's contract attributes
 * stopped matching the audience of the thing they hold. That flag exists
 * precisely so a campaign can consume it, and it is exactly the item a bulk
 * certify must not sweep up.
 */
export const HIGH_RISK_FLAGS: readonly string[] = [
  'unattributable',
  'privileged',
  'sod_violation',
  'stale',
  'needs_review',
];

export function isBulkCertifiable(item: {
  riskFlags: readonly string[];
  coverageStatus: string;
}): boolean {
  if (item.riskFlags.some((flag) => HIGH_RISK_FLAGS.includes(flag))) return false;
  // A holding whose source is partial is high-risk for the same reason a stale
  // one is: the reviewer is being asked to attest to something nobody read in
  // full.
  return item.coverageStatus === 'complete';
}

/**
 * Records that the reviewer FETCHED this item's detail, so the interval in the
 * decision is a server-side measurement rather than a client-reported dwell
 * time, which is worth nothing (§12).
 *
 * IT IS A COLUMN, NOT AN IN-PROCESS MAP. A module-level `Map<string, Date>` is
 * empty at decision time across two API workers, behind any load balancer, and
 * after any restart — so `itemOpenedAt === decidedAt` for everybody,
 * `medianIntervalMs` is 0 for every reviewer and `neverOpenedShare` is 1.0 for
 * every reviewer. §17 puts these signals in the evidence bundle as "the closest
 * thing to evidence of engagement the system can honestly produce", and a
 * signal that reads "instantaneous, never opened" about a reviewer who read
 * everything is worse than no signal: it is an accusation the bundle carries.
 * The map was also unbounded — one entry per (reviewer, item) for the life of
 * the process.
 *
 * `openedAt: null` in the `where` so the FIRST open is the one recorded. A
 * reviewer who opens an item, reads it, and opens it again before deciding has
 * not read it twice as fast.
 */
export async function openItem(
  tenantId: string,
  personId: string,
  itemId: string,
  now: Date = new Date(),
): Promise<{ openedAt: Date }> {
  return withTenant(tenantId, async (tx) => {
    await tx.campaignItemReviewer.updateMany({
      where: { itemId, personId, unassignedAt: null, openedAt: null },
      data: { openedAt: now },
    });
    const row = await tx.campaignItemReviewer.findFirst({
      where: { itemId, personId, unassignedAt: null },
      select: { openedAt: true },
    });
    return { openedAt: row?.openedAt ?? now };
  });
}

export interface CampaignDecisionInput {
  itemId: string;
  deciderPersonId: string;
  deciderUserId: string;
  decision: 'certify' | 'revoke';
  comment: string | null;
}

interface DecisionFacts {
  campaignStatus: string;
  itemStatus: string;
  itemPersonId: string | null;
  riskFlags: string[];
  coverageStatus: string;
  campaignId: string;
  resourceName: string;
  subjectKey: string;
  isReviewer: boolean;
  reviewerInvalid: string | null;
  subjectDeparted: boolean;
  openedAt: Date | null;
}

async function decisionFacts(
  tenantId: string,
  input: CampaignDecisionInput,
  now: Date,
): Promise<DecisionFacts> {
  return withTenant(tenantId, async (tx) => {
    const item = await tx.campaignItem.findUniqueOrThrow({
      where: { id: input.itemId },
      include: { reviewers: { where: { unassignedAt: null } } },
    });
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: item.campaignId } });

    const contracts =
      item.personId === null
        ? []
        : await tx.contract.findMany({
            where: { personId: item.personId },
            select: { startDate: true, endDate: true },
          });

    return {
      campaignStatus: campaign.status,
      itemStatus: item.status,
      itemPersonId: item.personId,
      riskFlags: item.riskFlags,
      coverageStatus: item.coverageStatus,
      campaignId: item.campaignId,
      resourceName: item.resourceName,
      subjectKey: item.subjectKey,
      isReviewer: item.reviewers.some((r) => r.personId === input.deciderPersonId),
      // Re-checked here because deactivation revoking sessions covers most of
      // it and "most of it" is not a security control.
      reviewerInvalid: await isValidApprover(tx, input.deciderPersonId, now),
      subjectDeparted:
        item.personId !== null &&
        !contracts.some((c) => c.startDate <= now && (c.endDate === null || c.endDate >= now)),
      openedAt: item.reviewers.find((r) => r.personId === input.deciderPersonId)?.openedAt ?? null,
    };
  });
}

/**
 * THE REFUSALS ARE COMPUTED BEFORE THE WRITE TRANSACTION OPENS.
 *
 * The previous form set a departed subject's item to `moot` and then threw
 * inside the SAME `withTenant`. `withTenant` is `prisma.$transaction(fn)`, so
 * the throw rolled the `moot` back with it: the item stayed `pending`, the
 * reviewer was told it "is now moot" when it was not, the same refusal repeated
 * for the rest of the campaign, and at `dueAt` the item became `undecided` and
 * raised a remediation item — so a leaver's holding ended up in the
 * manual-chase queue instead of on the `moot` line, and §12's coverage
 * arithmetic counted it against the organization.
 *
 * That was the fourth distinct route on this programme to a person's access
 * outliving their employment, and the shape is now a standing suspicion: ANY
 * CODE PATH THAT SPECIAL-CASES A DEPARTED PERSON IS SUSPECT UNTIL ITS FAILURE
 * MODE IS CHECKED.
 *
 * So: one short read-only transaction returns plain facts; the departure case
 * moots the item in its OWN COMMITTED transaction and only then throws; the
 * ordinary case writes in one transaction as before.
 */
export async function recordCampaignDecision(
  tenantId: string,
  input: CampaignDecisionInput,
  options: { now?: Date } = {},
): Promise<{ status: string }> {
  const now = options.now ?? new Date();
  const facts = await decisionFacts(tenantId, input, now);

  // `open`, and ONLY `open`. `executing` was in this gate and is written by
  // NOTHING in the tree -- and `closeDueCampaigns` closes `open` alone, so a
  // campaign that somehow reached `executing` would never close and every item
  // in it would stay decidable forever. A status with a reader and no writer is
  // a state machine describing something that does not exist.
  if (facts.campaignStatus !== 'open') {
    throw new CampaignDecisionRefusedError(
      'campaign_not_open',
      `this campaign is ${facts.campaignStatus}`,
    );
  }
  // `pending`, and ONLY `pending`. §11's item table has no
  // `blocked_no_reviewer -> certified` transition and `CERTIFYING_TRANSITIONS`
  // -- the constant the structural test asserts over -- names `pending` as its
  // only `from`. Admitting `blocked_no_reviewer` here contradicted both, and
  // was unreachable only because a blocked item has no active reviewer row so
  // the `not_reviewer` refusal fired first. Two guards, one of them wrong, is
  // one move away from the wrong one being the only guard.
  if (facts.itemStatus !== 'pending') {
    throw new CampaignDecisionRefusedError(
      'item_not_pending',
      `this item is already ${facts.itemStatus}`,
    );
  }

  // THE SELF-REVIEW INVARIANT, at the moment of decision as well as at
  // resolution. Every path Automate enumerated closes the same way, including
  // deciding through the API rather than the console.
  if (facts.itemPersonId !== null && facts.itemPersonId === input.deciderPersonId) {
    throw new CampaignDecisionRefusedError(
      'self_review',
      'no person may record a decision on an item whose subject is themselves',
    );
  }
  if (!facts.isReviewer) {
    throw new CampaignDecisionRefusedError('not_reviewer', 'this item is not assigned to you');
  }
  if (facts.reviewerInvalid !== null) {
    throw new CampaignDecisionRefusedError(
      'reviewer_invalid',
      `you may no longer decide: ${facts.reviewerInvalid}`,
    );
  }

  // A departed subject: certifying is refused AND the item moots. Revoking is
  // ALLOWED — a departure never suppresses a revocation.
  //
  // The moot is committed in its own transaction BEFORE the throw, so the item
  // really is `moot` after this call returns. The test asserts the status, not
  // the throw.
  if (facts.subjectDeparted && input.decision === 'certify') {
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({
        where: { id: input.itemId },
        data: {
          status: 'moot',
          statusReason:
            "the subject's contracts have all ended. A certification is a signed statement about somebody's access; signing one for a person who left would be false assurance.",
        },
      });
      await recordEvent(tx, {
        actorUserId: input.deciderUserId,
        action: 'govern.decision.refused',
        targetType: 'CampaignItem',
        targetId: input.itemId,
        outcome: 'failure',
        sourceIp: null,
        payload: { reason: 'subject_departed', mooted: true, campaignId: facts.campaignId },
      });
    });
    throw new CampaignDecisionRefusedError(
      'subject_departed',
      'this person has left; the item is now moot and cannot be certified. Revoking is still available.',
    );
  }

  // Revoking is one at a time, WITH A COMMENT.
  if (input.decision === 'revoke' && (input.comment ?? '').trim().length === 0) {
    throw new CampaignDecisionRefusedError(
      'comment_required',
      'a revoke decision requires a comment',
    );
  }
  // An unattributable holding is excluded from bulk certify AND given a
  // mandatory comment.
  if (
    input.decision === 'certify' &&
    facts.riskFlags.includes('unattributable') &&
    (input.comment ?? '').trim().length === 0
  ) {
    throw new CampaignDecisionRefusedError(
      'comment_required',
      'this holding has no recorded cause; certifying it requires a comment saying who said it was fine and why',
    );
  }

  return withTenant(tenantId, async (tx) => {
    const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: input.itemId } });
    const status = input.decision === 'certify' ? 'certified' : 'revoke_decided';

    // THE STATUS MOVES FIRST, UNDER A PREDICATE, AND THE ROW COUNT IS CHECKED.
    //
    // This is the lock. The previous form re-read the status here and then
    // wrote with `update({ where: { id } })` -- no predicate, no row lock, and
    // no unique index on `CampaignDecision(itemId)` -- so under READ COMMITTED
    // two reviewers holding one item both read `pending`, both passed, and both
    // committed. That shape is ordinary rather than exotic: `quorum: 'any'` is
    // normal for a role or group selector, and escalation ADDS a reviewer
    // rather than replacing one, so every escalated item has two. The item then
    // carried a certify AND a revoke -- `HoldingCertification` claiming
    // "certified" for a holding on its way into a revocation batch -- and
    // `closeDueCampaigns` broke the tie on `decidedAt`, which is identical
    // within a second.
    //
    // NOT a unique index on the decision instead. `closeDueCampaigns` takes the
    // LATEST decision per item deliberately -- "an item revoked and then
    // re-certified on appeal is certified" -- so one-decision-per-item would
    // forbid the case the close path is written for. Moving the row is the
    // lock; everything below runs only for the transaction that won it.
    const moved = await tx.campaignItem.updateMany({
      where: { id: item.id, status: 'pending' },
      data: { status },
    });
    if (moved.count !== 1) {
      // The loser re-reads the row it did not get to write, so the message
      // names what actually happened rather than the status it saw earlier.
      const current = await tx.campaignItem.findUniqueOrThrow({
        where: { id: input.itemId },
        select: { status: true },
      });
      throw new CampaignDecisionRefusedError(
        'item_not_pending',
        `this item is already ${current.status}`,
      );
    }

    const lastOrdinal = await tx.campaignDecision.count({
      where: { personId: input.deciderPersonId, item: { campaignId: item.campaignId } },
    });
    // `neverOpened` is recorded as a FACT rather than inferred from a timestamp
    // coincidence: `itemOpenedAt === decidedAt` is also what a decision made in
    // the same second as the open looks like.
    const openedAt = facts.openedAt ?? now;
    const neverOpened = facts.openedAt === null;

    const decision = await tx.campaignDecision.create({
      data: {
        tenantId,
        itemId: item.id,
        personId: input.deciderPersonId,
        decidedByUserId: input.deciderUserId,
        decision: input.decision,
        comment: input.comment,
        itemOpenedAt: openedAt,
        neverOpened,
        decidedAt: now,
        viaBulk: false,
        sessionDecisionOrdinal: lastOrdinal + 1,
        coverageAtDecision: {
          coverageStatus: item.coverageStatus,
          riskFlags: item.riskFlags,
        } as never,
      },
    });

    if (input.decision === 'certify') {
      await projectCertification(tx, item.id, decision.id, input.deciderPersonId);
    }

    await recordEvent(tx, {
      actorUserId: input.deciderUserId,
      action: 'govern.decision.record',
      targetType: 'CampaignItem',
      targetId: item.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        campaignId: item.campaignId,
        decision: input.decision,
        resourceName: item.resourceName,
        subjectKey: item.subjectKey,
        riskFlags: item.riskFlags,
        intervalMs: now.getTime() - openedAt.getTime(),
      },
    });

    return { status };
  });
}

/**
 * The projection `HoldingCertification` holds, rebuilt from the decision that
 * caused it. `CampaignDecision` rows remain the record.
 *
 * COMPOSITION HAZARD: this pairs with `rebaseCampaign`. A re-base that kept an
 * item — its holding did not change — must leave this row alone. Rolling it
 * back for every item of a re-based campaign would make a certification that is
 * still good read as never made. `rebaseCampaign` therefore only touches items
 * it re-opens, and it never writes here at all.
 */
export async function projectCertification(
  tx: TenantClient,
  itemId: string,
  decisionId: string,
  personId: string,
): Promise<void> {
  const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } });
  const subject = parseSubjectKey(item.subjectKey);
  if (subject === null) return;

  const subjectRefType = subject.kind;
  const subjectRefId = subject.kind === 'person' ? subject.personId : subject.accountRef;
  const decision = await tx.campaignDecision.findUniqueOrThrow({ where: { id: decisionId } });

  await tx.holdingCertification.upsert({
    where: {
      tenantId_subjectRefType_subjectRefId_systemId_resourceKind_resourceId: {
        tenantId: item.tenantId,
        subjectRefType,
        subjectRefId,
        systemId: item.systemId,
        resourceKind: item.resourceKind,
        resourceId: item.resourceId,
      },
    },
    create: {
      tenantId: item.tenantId,
      subjectRefType,
      subjectRefId,
      systemId: item.systemId,
      resourceKind: item.resourceKind,
      resourceId: item.resourceId,
      lastCertifiedAt: decision.decidedAt,
      lastCertifiedByPersonId: personId,
      lastCampaignId: item.campaignId,
      lastDecisionId: decisionId,
    },
    update: {
      lastCertifiedAt: decision.decidedAt,
      lastCertifiedByPersonId: personId,
      lastCampaignId: item.campaignId,
      lastDecisionId: decisionId,
    },
  });
}

/**
 * Allowed, BOUNDED, recorded as bulk on every decision it produces, and REFUSED
 * OUTRIGHT on high-risk items.
 *
 * The cap is tenant-wide — `GovernSettings.bulkCertifyLimit` — so that a
 * campaign cannot quietly raise it for itself.
 *
 * There is NO bulk revoke. Revoking is one at a time, with a comment, and the
 * batch of §13 is what makes the aggregate safe.
 */
export async function bulkCertify(
  tenantId: string,
  input: {
    campaignId: string;
    itemIds: readonly string[];
    deciderPersonId: string;
    deciderUserId: string;
  },
  options: { now?: Date } = {},
): Promise<{ certified: number; refused: { itemId: string; reason: string }[] }> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: input.campaignId } });
    // THE SAME GATE THE SINGLE PATH ENFORCES. `bulkCertify` checked
    // `allowBulkCertify` and the tenant's cap and neither of these, so a closed
    // campaign's items could still be certified in bulk while the single path
    // refused them one at a time. A carve-out present on one of two entry
    // points to the same table is not a carve-out; it is a hole.
    if (campaign.status !== 'open') {
      throw new CampaignDecisionRefusedError(
        'campaign_not_open',
        `this campaign is ${campaign.status}`,
      );
    }
    if (!campaign.allowBulkCertify) {
      throw new CampaignDecisionRefusedError(
        'bulk_not_allowed',
        'this campaign does not permit bulk certify',
      );
    }
    const settings = await governSettings(tx);
    if (input.itemIds.length > settings.bulkCertifyLimit) {
      throw new CampaignDecisionRefusedError(
        'bulk_too_large',
        `a bulk certify is capped at ${settings.bulkCertifyLimit} items per action for this tenant`,
      );
    }

    const invalid = await isValidApprover(tx, input.deciderPersonId, now);
    if (invalid !== null) {
      throw new CampaignDecisionRefusedError(
        'reviewer_invalid',
        `you may no longer decide: ${invalid}`,
      );
    }

    const items = await tx.campaignItem.findMany({
      where: { id: { in: [...input.itemIds] }, campaignId: input.campaignId },
      include: {
        reviewers: { where: { unassignedAt: null }, select: { personId: true, openedAt: true } },
      },
    });

    // ONE query over every subject in the batch, not one per item. A bulk
    // certify is capped at `bulkCertifyLimit` items and a contract read per
    // item inside this transaction would be that many round trips against the
    // 5000 ms ceiling.
    const subjectIds = [
      ...new Set(items.map((i) => i.personId).filter((p): p is string => p !== null)),
    ];
    const liveContracts =
      subjectIds.length === 0
        ? []
        : await tx.contract.findMany({
            where: {
              personId: { in: subjectIds },
              startDate: { lte: now },
              OR: [{ endDate: null }, { endDate: { gte: now } }],
            },
            select: { personId: true },
          });
    const stillEmployed = new Set(liveContracts.map((c) => c.personId));
    const departed = new Set(subjectIds.filter((id) => !stillEmployed.has(id)));

    const refused: { itemId: string; reason: string }[] = [];
    const certified: string[] = [];
    const eligible: typeof items = [];

    for (const item of items) {
      if (item.status !== 'pending') {
        refused.push({ itemId: item.id, reason: `this item is already ${item.status}` });
        continue;
      }
      if (item.personId === input.deciderPersonId) {
        refused.push({ itemId: item.id, reason: 'you are the subject of this item' });
        continue;
      }
      // A DEPARTED SUBJECT, refused AND mooted, exactly as the single path does
      // it. Their items stay `pending` until the nightly `mootDepartedSubjects`
      // sweep runs, so between the departure and that sweep a manager could
      // bulk-certify somebody who has left -- which `recordCampaignDecision`
      // calls false assurance and refuses in words. That was the fifth route on
      // this programme to a person's access outliving their employment, and the
      // standing suspicion applies: any code path that special-cases a departed
      // person is suspect until its failure mode is checked.
      if (item.personId !== null && departed.has(item.personId)) {
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: 'moot',
            statusReason:
              "the subject's contracts have all ended. A certification is a signed statement about somebody's access; signing one for a person who left would be false assurance.",
          },
        });
        refused.push({
          itemId: item.id,
          reason: 'this person has left; the item is now moot and cannot be certified',
        });
        continue;
      }
      if (!item.reviewers.some((r) => r.personId === input.deciderPersonId)) {
        refused.push({ itemId: item.id, reason: 'this item is not assigned to you' });
        continue;
      }
      if (!isBulkCertifiable(item)) {
        // In words, rather than as a disabled button with no explanation.
        const named = [
          ...item.riskFlags,
          ...(item.coverageStatus === 'complete' ? [] : [item.coverageStatus]),
        ];
        refused.push({
          itemId: item.id,
          reason:
            `this item is high-risk (${named.join(', ')}) ` +
            `and must be decided one at a time, with a comment`,
        });
        continue;
      }
      eligible.push(item);
    }

    const startOrdinal = await tx.campaignDecision.count({
      where: { personId: input.deciderPersonId, item: { campaignId: input.campaignId } },
    });

    // The reviewer's own `openedAt` per item, read from the reviewer rows
    // already loaded. A persisted column, not a module-level Map that is empty
    // on a second worker and after every restart.
    const openedByItem = new Map<string, Date>(
      eligible.flatMap((item) =>
        item.reviewers
          .filter((r) => r.personId === input.deciderPersonId && r.openedAt !== null)
          .map((r) => [item.id, r.openedAt!] as const),
      ),
    );

    for (const [index, item] of eligible.entries()) {
      // The same conditional move as the single path, for the same reason: the
      // eligibility loop above read these statuses in THIS transaction, but a
      // reviewer deciding one of them singly in another transaction is exactly
      // the concurrency this file now refuses to lose.
      const moved = await tx.campaignItem.updateMany({
        where: { id: item.id, status: 'pending' },
        data: { status: 'certified' },
      });
      if (moved.count !== 1) {
        refused.push({ itemId: item.id, reason: 'somebody else decided this item first' });
        continue;
      }

      const openedAt = openedByItem.get(item.id) ?? now;
      const decision = await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId: item.id,
          personId: input.deciderPersonId,
          decidedByUserId: input.deciderUserId,
          decision: 'certify',
          comment: null,
          itemOpenedAt: openedAt,
          neverOpened: !openedByItem.has(item.id),
          decidedAt: now,
          viaBulk: true,
          bulkSize: eligible.length,
          sessionDecisionOrdinal: startOrdinal + index + 1,
          coverageAtDecision: {
            coverageStatus: item.coverageStatus,
            riskFlags: item.riskFlags,
          } as never,
        },
      });
      await projectCertification(tx, item.id, decision.id, input.deciderPersonId);
      certified.push(item.id);
    }

    // ONE audit event naming the items and the reviewer, not one per item.
    // `recordEvent` takes a per-tenant advisory lock for the duration of its
    // transaction, and fifty thousand separately-audited decisions would be
    // fifty thousand serialized transactions on one tenant's chain. Nothing is
    // lost: the audit event is the tamper-evident anchor for a set of rows that
    // are themselves complete.
    //
    // `certified`, not `eligible`: an item whose conditional move lost the race
    // above was decided by somebody else, and an audit event naming items this
    // reviewer did not actually write is a worse record than no event at all.
    if (certified.length > 0) {
      await recordEvent(tx, {
        actorUserId: input.deciderUserId,
        action: 'govern.decision.bulk_certify',
        targetType: 'Campaign',
        targetId: input.campaignId,
        outcome: 'success',
        sourceIp: null,
        payload: {
          reviewerPersonId: input.deciderPersonId,
          bulkSize: certified.length,
          itemIds: certified,
          refusedCount: refused.length,
        },
      });
    }

    return { certified: certified.length, refused };
  });
}

/**
 * Context for a human, offered as signals rather than as proof.
 *
 * A manager of a stable ten-person team who reads everything and certifies all
 * of it in four minutes is behaving correctly and will look identical to a
 * rubber-stamper on the aggregate. None of these are violations and the screen
 * does not call them violations.
 */
export async function computeReviewQualitySignals(
  tenantId: string,
  campaignId: string,
  now: Date = new Date(),
  batchSize = 200,
): Promise<number> {
  // Plain data out of short, paged transactions. One `withTenant` over every
  // item with every reviewer and every decision, plus an upsert per reviewer,
  // is the same unbounded-loop-in-one-transaction shape as the rest of slice 2.
  const assigned = new Map<string, number>();
  let cursor: string | null = null;
  for (;;) {
    const page: { id: string; personId: string }[] = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({
        where: {
          item: { campaignId },
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        select: { id: true, personId: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      }),
    );
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    for (const row of page) assigned.set(row.personId, (assigned.get(row.personId) ?? 0) + 1);
  }

  interface DecisionRow {
    personId: string;
    decision: string;
    viaBulk: boolean;
    neverOpened: boolean;
    itemOpenedAt: Date;
    decidedAt: Date;
    sessionDecisionOrdinal: number;
  }
  const byPerson = new Map<string, DecisionRow[]>();
  cursor = null;
  for (;;) {
    const page: (DecisionRow & { id: string })[] = await withTenant(tenantId, (tx) =>
      tx.campaignDecision.findMany({
        where: { item: { campaignId }, ...(cursor === null ? {} : { id: { gt: cursor } }) },
        select: {
          id: true,
          personId: true,
          decision: true,
          viaBulk: true,
          neverOpened: true,
          itemOpenedAt: true,
          decidedAt: true,
          sessionDecisionOrdinal: true,
        },
        orderBy: { id: 'asc' },
        take: batchSize,
      }),
    );
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    for (const row of page) byPerson.set(row.personId, [...(byPerson.get(row.personId) ?? []), row]);
  }

  const drafts: {
    personId: string;
    itemsAssigned: number;
    itemsDecided: number;
    certifiedShare: number;
    medianIntervalMs: number;
    bulkShare: number;
    largestBurst: number;
    largestBurstMs: number;
    neverOpenedShare: number;
  }[] = [];

  for (const [personId, itemsAssigned] of assigned) {
    const mine = (byPerson.get(personId) ?? []).sort(
      (a, b) => a.sessionDecisionOrdinal - b.sessionDecisionOrdinal,
    );
    if (mine.length === 0) continue;

    const intervals = mine
      .map((d) => d.decidedAt.getTime() - d.itemOpenedAt.getTime())
      .sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)] ?? 0;

    // A RUN OF CONSECUTIVE DECISIONS, and the elapsed time across that run —
    // which is what §12 describes and what the screen's label says. It is NOT
    // `max(bulkSize)`: a reviewer who decides 40 items one at a time in ninety
    // seconds is exactly the behaviour this signal exists to surface, and
    // `max(bulkSize)` reports 0 for them. Consecutive by
    // `sessionDecisionOrdinal`, which is per reviewer per campaign and is an
    // explicit ordinal precisely because `createdAt` is transaction start time.
    let largestBurst = 0;
    let largestBurstMs = 0;
    let runLength = 0;
    let runStartedAt: Date | null = null;
    let previousOrdinal: number | null = null;
    for (const decision of mine) {
      const consecutive =
        previousOrdinal !== null && decision.sessionDecisionOrdinal === previousOrdinal + 1;
      if (consecutive) {
        runLength += 1;
      } else {
        runLength = 1;
        runStartedAt = decision.decidedAt;
      }
      previousOrdinal = decision.sessionDecisionOrdinal;
      if (runLength > largestBurst) {
        largestBurst = runLength;
        largestBurstMs =
          decision.decidedAt.getTime() - (runStartedAt ?? decision.decidedAt).getTime();
      }
    }

    drafts.push({
      personId,
      itemsAssigned,
      itemsDecided: mine.length,
      certifiedShare: mine.filter((d) => d.decision === 'certify').length / mine.length,
      medianIntervalMs: median,
      bulkShare: mine.filter((d) => d.viaBulk).length / mine.length,
      largestBurst,
      largestBurstMs,
      // The RECORDED FACT, not a timestamp coincidence. A decision made in the
      // same second as the open is not a decision made without opening.
      neverOpenedShare: mine.filter((d) => d.neverOpened).length / mine.length,
    });
  }

  let written = 0;
  for (let i = 0; i < drafts.length; i += batchSize) {
    const batch = drafts.slice(i, i + batchSize);
    await withTenant(tenantId, async (tx) => {
      for (const draft of batch) {
        const { personId, ...values } = draft;
        await tx.reviewQualitySignal.upsert({
          where: { campaignId_personId: { campaignId, personId } },
          create: { tenantId, campaignId, personId, ...values, computedAt: now },
          update: { ...values, computedAt: now },
        });
        written += 1;
      }
    });
  }

  return written;
}
