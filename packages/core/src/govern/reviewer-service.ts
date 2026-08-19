import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import {
  isValidApprover,
  resolveEscalationApprovers,
  resolveStageApprovers,
  type ApproverSelector,
  type ResolutionSubject,
  type SelectorConfig,
  type StageSnapshot,
} from '../automate/approvers.js';
import {
  displayNames,
  enqueueOutbox,
  recipientsForPersons,
  usersWithPermission,
} from '../automate/notify.js';
import { PERMISSIONS } from '../rbac/permissions.js';
// Task 19, dispatched BEFORE this task. §12's reviewer-quality section "is not
// hidden behind a toggle", so `closeDueCampaigns` computes the signals rather
// than leaving `ReviewQualitySignal` permanently empty. Task 19 imports nothing
// from here.
import { computeReviewQualitySignals } from './decision-service.js';
import { createRemediationItem, upsertFindings } from './finding-service.js';
import { readableSnapshot } from './readable.js';
import { governSettings } from './settings-service.js';

export const REVIEWER_BATCH = 200;

/**
 * Automate's selector machinery, REUSED rather than reimplemented.
 *
 * An approval chain and a review chain disagreeing about who somebody's manager
 * is would be a support call nobody can close, and Automate already resolved
 * which contract supplies the manager. This builds the `StageSnapshot` shape
 * `resolveStageApprovers` expects out of the campaign's own selector fields.
 */
function stageFor(campaign: {
  reviewerSelector: string;
  reviewerConfig: unknown;
  fallbackSelector: string;
  fallbackConfig: unknown;
}): StageSnapshot {
  return {
    sequence: 1,
    name: 'review',
    selector: campaign.reviewerSelector as ApproverSelector,
    selectorConfig: (campaign.reviewerConfig ?? {}) as SelectorConfig,
    quorum: 'any',
    fallbackSelector: campaign.fallbackSelector as ApproverSelector,
    fallbackConfig: (campaign.fallbackConfig ?? {}) as SelectorConfig,
    slaHours: 0,
    onTimeout: 'remind',
    escalationSelector: 'manager',
    escalationConfig: {},
    expiryHours: null,
  };
}

/**
 * Automate's `ResourceType` is `'entitlement' | 'application' | 'group'`, and
 * `ResourceOwner` is keyed on it. A campaign covers three kinds Automate has no
 * resource type for — `syntraRole`, `syntraUser` and `targetAccount` — so this
 * returns `null` for them rather than mapping them onto `'entitlement'`, where
 * a `resourceOwner` selector would look up an entitlement id that is not one,
 * silently find nothing, and fall through to the fallback with no explanation.
 */
export function automateResourceType(
  resourceKind: string,
): 'entitlement' | 'application' | 'group' | null {
  return resourceKind === 'application'
    ? 'application'
    : resourceKind === 'syntraGroup'
      ? 'group'
      : resourceKind === 'targetEntitlement'
        ? 'entitlement'
        : null;
}

/** The three kinds `resourceOwner` cannot resolve, named once. */
export const RESOURCE_OWNER_UNSUPPORTED_KINDS: readonly string[] = [
  'syntraRole',
  'syntraUser',
  'targetAccount',
];

/**
 * The named fallback person for an item that HAS NO SUBJECT PERSON.
 *
 * `ResolutionSubject.subjectPersonId` is `string` and not `string | null`, so
 * an unattributed account cannot be handed to `resolveStageApprovers` at all —
 * and a zero UUID in its place is a sentinel a `person` selector configured
 * with that value would silently match. Widening Automate's type for this one
 * caller is the wrong trade, and reimplementing its `role` and `group`
 * expansion here is the reimplementation this module exists not to do.
 *
 * So: an account item resolves to the campaign's fallback ONLY when that
 * fallback is a named `person`, and otherwise becomes `blocked_no_reviewer`
 * with the reason stated. A blocked item is visible, chased and counted; a
 * silently-misresolved one is not.
 */
function fallbackPersonFor(stage: StageSnapshot): string | null {
  return stage.fallbackSelector === 'person' ? (stage.fallbackConfig.personId ?? null) : null;
}

/** The fallback-only resolution an account item gets, in `ResolutionResult` shape. */
function fallbackOnly(stage: StageSnapshot): {
  approvers: { personId: string }[];
  usedFallback: boolean;
} {
  const personId = fallbackPersonFor(stage);
  return { approvers: personId === null ? [] : [{ personId }], usedFallback: true };
}

/**
 * The self-review invariant, applied as a SUBTRACTION FROM THE RESOLVED SET so
 * that every selector inherits it, and applied at the END of expansion so no
 * expansion step can reintroduce what an earlier one removed (Ruling A-6).
 *
 * `resolveStageApprovers` already subtracts the subject; this passes the item's
 * subject as the resolution subject so that it does. The one path new here is
 * the resource owner who holds the resource — the finance systems manager in
 * the finance group — and dropping them from their own item while leaving them
 * the other 300 is correct and is what happens.
 *
 * Returns `null` for an item whose subject is an unattributed ACCOUNT.
 * `resolveItemReviewers` routes a null subject straight to the fallback and
 * says so in the item's `statusReason`.
 */
function subjectFor(item: {
  personId: string | null;
  systemId: string;
  resourceKind: string;
  resourceId: string;
}): ResolutionSubject | null {
  if (item.personId === null) return null;
  const resourceType = automateResourceType(item.resourceKind);
  return {
    subjectPersonId: item.personId,
    // A campaign item has no submitter. That is the one Automate path with no
    // analogue here.
    submitterPersonId: null,
    productOwnerPersonId: null,
    productOwnerGroupId: null,
    productCategory: null,
    // An empty `resources` for a kind Automate cannot key on, so a
    // `resourceOwner` selector resolves to nobody and FALLS BACK rather than
    // resolving against a resource type that is a lie.
    resources: resourceType === null ? [] : [{ resourceType, resourceId: item.resourceId }],
  };
}

/**
 * The resolution subject for ESCALATION, which is about the REVIEWER and not
 * about the item. §12: escalation goes to `Contract.managerPersonId` on "the
 * reviewer's own resolved contract", the same relation Automate's `manager`
 * selector uses and not a second one.
 */
function reviewerAsSubject(personId: string): ResolutionSubject {
  return {
    subjectPersonId: personId,
    submitterPersonId: null,
    productOwnerPersonId: null,
    productOwnerGroupId: null,
    productCategory: null,
    resources: [],
  };
}

export interface ResolveOutcome {
  assignedByPerson: Map<string, number>;
  blocked: number;
}

export async function resolveItemReviewers(
  tx: TenantClient,
  campaignId: string,
  itemIds: readonly string[],
  now: Date,
): Promise<ResolveOutcome> {
  const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const stage = stageFor(campaign);
  const items = await tx.campaignItem.findMany({ where: { id: { in: [...itemIds] } } });

  const assignedByPerson = new Map<string, number>();
  const blockedItems: string[] = [];

  for (const item of items) {
    const subject = subjectFor(item);

    // An unattributed account has no person and no contract, so no selector
    // over people can resolve it. It goes to the campaign's named fallback
    // person if there is one, and is blocked with a reason if there is not.
    const resolution =
      subject === null ? fallbackOnly(stage) : await resolveStageApprovers(tx, stage, subject, now);

    if (resolution.approvers.length === 0) {
      blockedItems.push(item.id);
      await tx.campaignItem.update({
        where: { id: item.id },
        data: {
          status: 'blocked_no_reviewer',
          statusReason:
            subject === null
              ? 'this item is an account that belongs to nobody, so no selector over people can resolve it, ' +
                'and the campaign fallback also resolved to nobody. Attribute the account or name a fallback person.'
              : 'the reviewer selector and the fallback both resolved to nobody who may decide this. ' +
                'The likeliest cause is that everybody they resolved to would be attesting to their own access.',
        },
      });
      continue;
    }

    for (const approver of resolution.approvers) {
      await tx.campaignItemReviewer.create({
        data: {
          tenantId: campaign.tenantId,
          itemId: item.id,
          personId: approver.personId,
          via: resolution.usedFallback ? 'fallback' : 'selector',
          assignedAt: now,
        },
      });
      assignedByPerson.set(approver.personId, (assignedByPerson.get(approver.personId) ?? 0) + 1);
    }
  }

  if (blockedItems.length > 0) {
    // It never auto-decides and it never sits silently. `blocked_no_approver`'s
    // twin, for the same reason.
    const owners = await recipientsForPersons(tx, [campaign.ownerPersonId]);
    const managers = await usersWithPermission(tx, PERMISSIONS.GOVERN_MANAGE);
    await enqueueOutbox(
      tx,
      [...owners, ...managers].map((recipient) => ({
        template: 'govern-campaign-blocked-item' as const,
        to: recipient.email,
        vars: {
          displayName: recipient.displayName,
          campaignName: campaign.name,
          itemCount: String(blockedItems.length),
          campaignUrl: `/admin/govern/campaigns/${campaignId}`,
        },
        requestId: null,
        userId: recipient.userId,
      })),
    );
  }

  return { assignedByPerson, blocked: blockedItems.length };
}

/**
 * A reviewer is VALID only if they hold an `active` Syntra `User` and their
 * `Person` holds at least one active contract. Automate's definition, reused,
 * and re-checked at the moment of each decision as well as here — deactivation
 * revoking sessions covers most of it and "most of it" is not a security
 * control.
 *
 * DECISIONS ALREADY RECORDED STAND. They were valid when made, and the evidence
 * bundle shows the reviewer's status as at the decision, not as at export.
 */
export async function reassignInvalidReviewers(
  tenantId: string,
  campaignId: string,
  options: { now?: Date; publicUrl?: string; batchSize?: number } = {},
): Promise<{ reassigned: number; blocked: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? REVIEWER_BATCH;

  const campaign = await withTenant(tenantId, (tx) =>
    tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
  );

  let reassigned = 0;
  let blocked = 0;
  let cursor: string | null = null;

  // ONE TRANSACTION PER BATCH. Holding one transaction over every open item of
  // the campaign — with an `isValidApprover` per reviewer and a full
  // `resolveStageApprovers` per item inside it — is the shape §17's 50,000-item
  // campaigns break.
  for (;;) {
    const open = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({
        // Only items still awaiting a decision. A certified or revoke_decided
        // item is finished with its reviewer.
        where: {
          campaignId,
          status: { in: ['pending', 'blocked_no_reviewer'] },
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        include: { reviewers: { where: { unassignedAt: null } } },
        orderBy: { id: 'asc' },
        take: batchSize,
      }),
    );
    if (open.length === 0) break;
    cursor = open[open.length - 1]!.id;

    await withTenant(tenantId, async (tx) => {
      for (const item of open) {
        const invalid: string[] = [];
        for (const reviewer of item.reviewers) {
          if ((await isValidApprover(tx, reviewer.personId, now)) !== null) {
            invalid.push(reviewer.personId);
          }
        }
        if (invalid.length === 0 && item.reviewers.length > 0) continue;

        for (const personId of invalid) {
          await tx.campaignItemReviewer.updateMany({
            where: { itemId: item.id, personId, unassignedAt: null },
            data: { unassignedAt: now, unassignedReason: 'this reviewer is no longer valid' },
          });
        }

        const subject = subjectFor(item);
        const stage = stageFor(campaign);
        const resolution =
          subject === null
            ? fallbackOnly(stage)
            : await resolveStageApprovers(tx, stage, subject, now);
        const incoming = resolution.approvers.filter((a) => !invalid.includes(a.personId));

        if (incoming.length === 0) {
          blocked += 1;
          await tx.campaignItem.update({
            where: { id: item.id },
            data: {
              status: 'blocked_no_reviewer',
              statusReason: 'the reviewer became invalid and re-resolution yielded nobody',
            },
          });
          continue;
        }

        for (const approver of incoming) {
          await tx.campaignItemReviewer.create({
            data: {
              tenantId,
              itemId: item.id,
              personId: approver.personId,
              via: 'reassignment',
              assignedAt: now,
            },
          });
        }
        // BACK TO `pending`. Leaving a successfully-reassigned item on
        // `blocked_no_reviewer` keeps it on the blocked dashboard forever, and
        // `recordCampaignDecision` would then have to permit a
        // `blocked_no_reviewer -> certified` transition that
        // `CERTIFYING_TRANSITIONS = [{ from: 'pending' }]` says does not exist.
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: 'pending',
            statusReason: 'the previous reviewer became invalid and this item was reassigned',
          },
        });
        reassigned += 1;

        const parties = await recipientsForPersons(tx, [
          ...invalid,
          ...incoming.map((a) => a.personId),
        ]);
        const names = await displayNames(tx, { personIds: invalid });
        await enqueueOutbox(
          tx,
          parties.map((recipient) => ({
            template: 'govern-review-reassigned' as const,
            to: recipient.email,
            vars: {
              displayName: recipient.displayName,
              campaignName: campaign.name,
              itemCount: '1',
              previousReviewer:
                names.get(`person:${invalid[0] ?? ''}`) ?? 'the previous reviewer',
              reviewUrl: `${options.publicUrl ?? ''}/govern/reviews?campaign=${campaignId}`,
            },
            requestId: null,
            userId: recipient.userId,
          })),
        );
      }
    });
  }

  if (reassigned > 0 || blocked > 0) {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'govern.campaign.reassign',
        targetType: 'Campaign',
        targetId: campaignId,
        outcome: 'success',
        sourceIp: null,
        payload: { reassigned, blocked },
      }),
    );
  }
  return { reassigned, blocked };
}

/**
 * `moot` is NOT a bucket to hide things in.
 *
 * Only `pending` and `blocked_no_reviewer` items moot. AN ITEM ALREADY CARRYING
 * A REVOKE DECISION DOES NOT: composing "a departed subject's item is moot"
 * with "a decision stands" the naive way means a leaver's holding is mooted,
 * the decision never dispatches, and the campaign reports it handled. A
 * leaver's access must still be removable. This is one of the three composition
 * hazards named in the Global Constraints.
 */
export async function mootDepartedSubjects(
  tenantId: string,
  campaignId: string,
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ mooted: number; preserved: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? REVIEWER_BATCH;

  let mooted = 0;
  let preserved = 0;
  let cursor: string | null = null;

  // Paged. A campaign §17 sizes at 50,000 items would otherwise load every item
  // and every contract for every subject into one transaction and then issue an
  // update per mooted row inside it.
  for (;;) {
    const items = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({
        where: {
          campaignId,
          personId: { not: null },
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        select: { id: true, personId: true, status: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      }),
    );
    if (items.length === 0) break;
    cursor = items[items.length - 1]!.id;

    const contracts = await withTenant(tenantId, (tx) =>
      tx.contract.findMany({
        where: { personId: { in: items.map((i) => i.personId!) } },
        select: { personId: true, startDate: true, endDate: true },
      }),
    );

    const activeByPerson = new Map<string, boolean>();
    const latestEnd = new Map<string, Date>();
    for (const c of contracts) {
      const active = c.startDate <= now && (c.endDate === null || c.endDate >= now);
      activeByPerson.set(c.personId, (activeByPerson.get(c.personId) ?? false) || active);
      if (c.endDate !== null) {
        const current = latestEnd.get(c.personId);
        if (current === undefined || c.endDate > current) latestEnd.set(c.personId, c.endDate);
      }
    }

    await withTenant(tenantId, async (tx) => {
      for (const item of items) {
        if (activeByPerson.get(item.personId!) === true) continue;
        if (item.status !== 'pending' && item.status !== 'blocked_no_reviewer') {
          preserved += 1;
          continue;
        }
        const departedOn = latestEnd.get(item.personId!);
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: 'moot',
            statusReason:
              `the subject's contracts have all ended${
                departedOn === undefined ? '' : ` on ${departedOn.toISOString().slice(0, 10)}`
              }. ` +
              `Provision's leaver ladder and Automate's lapse sweep now own this holding; asking a manager to attest to it would be theatre. ` +
              `This item is NOT counted as certified in any figure.`,
          },
        });
        mooted += 1;
      }
    });
  }

  return { mooted, preserved };
}

/** VERIFIED against the current snapshot, never inferred from a revocation somebody else dispatched. */
export async function mootVanishedHoldings(
  tenantId: string,
  campaignId: string,
  currentSnapshotId: string,
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ mooted: number }> {
  const batchSize = options.batchSize ?? REVIEWER_BATCH;
  let mooted = 0;

  // The cursor advances over every item the page saw, mooted or not: the items
  // that survive would otherwise repeat forever.
  let cursor: string | null = null;
  for (;;) {
    const items = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({
        where: {
          campaignId,
          status: { in: ['pending', 'blocked_no_reviewer'] },
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
      }),
    );
    if (items.length === 0) break;
    cursor = items[items.length - 1]!.id;

    const present = await withTenant(tenantId, (tx) =>
      tx.holding.findMany({
        where: { snapshotId: currentSnapshotId, subjectKey: { in: items.map((i) => i.subjectKey) } },
        select: { subjectKey: true, systemId: true, resourceKind: true, resourceId: true },
      }),
    );
    const keys = new Set(
      present.map((h) => `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`),
    );

    const gone = items.filter(
      (item) =>
        !keys.has(`${item.subjectKey}|${item.systemId}|${item.resourceKind}|${item.resourceId}`),
    );
    if (gone.length > 0) {
      await withTenant(tenantId, async (tx) => {
        const result = await tx.campaignItem.updateMany({
          where: { id: { in: gone.map((i) => i.id) } },
          data: {
            status: 'moot',
            statusReason: `snapshot ${currentSnapshotId} no longer shows this holding`,
          },
        });
        mooted += result.count;
      });
    }
  }

  return { mooted };
}

/**
 * Reminders at 50% and 100% of the time to `dueAt`, then daily. A campaign
 * never stops asking, and it never certifies and never revokes on silence.
 */
export async function runCampaignReminders(
  tenantId: string,
  options: { now?: Date; publicUrl?: string; batchSize?: number } = {},
): Promise<{ reminded: number; escalated: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? REVIEWER_BATCH;
  let reminded = 0;
  let escalated = 0;

  const campaigns = await withTenant(tenantId, (tx) =>
    tx.campaign.findMany({
      where: { status: 'open' },
      select: {
        id: true,
        name: true,
        opensAt: true,
        dueAt: true,
        reviewerSelector: true,
        reviewerConfig: true,
        fallbackSelector: true,
        fallbackConfig: true,
      },
    }),
  );

  for (const campaign of campaigns) {
    const elapsed = now.getTime() - campaign.opensAt.getTime();
    const total = campaign.dueAt.getTime() - campaign.opensAt.getTime();
    const share = total <= 0 ? 1 : elapsed / total;
    if (share < 0.5) continue;

    /**
     * Escalation fires in the LAST DAY before `dueAt`, not at or after it.
     *
     * `share >= 1` reads as "escalate at 100% of the time to due", and it gives
     * the escalated manager no time at all: `closeDueCampaigns` runs on the
     * same tick and marks every still-pending item `undecided`. An escalation
     * that arrives after the campaign has closed is a notification about a
     * decision nobody can now make.
     *
     * A day, because the reminder cadence below is daily — so the last reminder
     * a silent reviewer gets is also the one that tells them they have been
     * escalated past, which is the message §12 wants them to have.
     */
    const escalating = now.getTime() >= campaign.dueAt.getTime() - 86_400_000;

    // Plain data out of a short transaction, then one transaction per reviewer
    // batch.
    const rows = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({
        where: {
          unassignedAt: null,
          item: { campaignId: campaign.id, status: 'pending' },
          // PER REVIEWER, not per campaign. A de-duplication that asks
          // NotificationOutbox for any reminder naming this campaign in the
          // last 24 hours and narrows it by nothing else reminds the first
          // reviewer in the iteration and silently skips all the others —
          // forever, because tomorrow the same reviewer is first again. A
          // campaign with 200 reviewers reminds one of them, and escalation
          // sits downstream of the same skip.
          OR: [
            { lastRemindedAt: null },
            { lastRemindedAt: { lt: new Date(now.getTime() - 86_400_000) } },
          ],
        },
        select: { id: true, personId: true, itemId: true },
      }),
    );
    if (rows.length === 0) continue;

    const byReviewer = new Map<string, { reviewerRowIds: string[]; itemIds: string[] }>();
    for (const row of rows) {
      const entry = byReviewer.get(row.personId) ?? { reviewerRowIds: [], itemIds: [] };
      entry.reviewerRowIds.push(row.id);
      entry.itemIds.push(row.itemId);
      byReviewer.set(row.personId, entry);
    }

    const reviewers = [...byReviewer];
    for (let i = 0; i < reviewers.length; i += batchSize) {
      const batch = reviewers.slice(i, i + batchSize);
      const outcome = await withTenant(tenantId, async (tx) => {
        let sent = 0;
        let raised = 0;

        for (const [personId, entry] of batch) {
          // A reminder in a leaver's mailbox is a campaign asking somebody who
          // no longer works there to certify somebody else's access.
          if ((await isValidApprover(tx, personId, now)) !== null) continue;

          const recipients = await recipientsForPersons(tx, [personId]);
          await enqueueOutbox(
            tx,
            recipients.map((recipient) => ({
              template: 'govern-review-reminder' as const,
              to: recipient.email,
              vars: {
                displayName: recipient.displayName,
                campaignName: campaign.name,
                itemCount: String(entry.itemIds.length),
                dueAt: campaign.dueAt.toDateString(),
                reviewUrl: `${options.publicUrl ?? ''}/govern/reviews?campaign=${campaign.id}`,
              },
              requestId: null,
              userId: recipient.userId,
            })),
          );
          // The cadence is driven from the reviewer's own row, so it is per
          // reviewer per campaign and two campaigns with the same name cannot
          // suppress each other.
          await tx.campaignItemReviewer.updateMany({
            where: { id: { in: entry.reviewerRowIds } },
            data: { lastRemindedAt: now },
          });
          sent += 1;

          if (escalating) {
            // Escalation ADDS a reviewer and never replaces one, and it tells
            // the original they were escalated past.
            //
            // THE SUBJECT IS THE REVIEWER, NOT THE ITEM. §12: escalation goes
            // to "`Contract.managerPersonId` on THE REVIEWER'S OWN RESOLVED
            // CONTRACT". Passing the first pending item's subject resolves an
            // arbitrary person's manager and grants them review authority over
            // items they have no relationship to — and if that arbitrary
            // subject's manager is themselves the subject of one of the
            // escalated items, they now review their own access, which the
            // self-review invariant is only re-checked for against the ITEM's
            // own subject.
            const escalation = await resolveEscalationApprovers(
              tx,
              stageFor(campaign),
              reviewerAsSubject(personId),
              now,
            );
            const added = escalation.approvers.filter((a) => a.personId !== personId);
            if (added.length === 0) continue;

            for (const itemId of entry.itemIds) {
              for (const approver of added) {
                // `findFirst` then `create`, with NO swallowed error.
                //
                // An `upsert` on a synthesised `id` like `${itemId}:${personId}`
                // is not a uuid, so the query errors before `create` is
                // reached; and a query error inside a Prisma interactive
                // transaction leaves the Postgres transaction ABORTED, so a
                // `.catch(() => undefined)` does not rescue the one escalation
                // — it kills the whole reminder run with "current transaction
                // is aborted" on the next statement.
                const existing = await tx.campaignItemReviewer.findFirst({
                  where: { itemId, personId: approver.personId, unassignedAt: null },
                  select: { id: true },
                });
                if (existing !== null) continue;
                await tx.campaignItemReviewer.create({
                  data: {
                    tenantId,
                    itemId,
                    personId: approver.personId,
                    via: 'escalation',
                    assignedAt: now,
                  },
                });
              }
            }

            const names = await displayNames(tx, { personIds: added.map((a) => a.personId) });
            await enqueueOutbox(
              tx,
              recipients.map((recipient) => ({
                template: 'govern-review-escalated' as const,
                to: recipient.email,
                vars: {
                  displayName: recipient.displayName,
                  campaignName: campaign.name,
                  itemCount: String(entry.itemIds.length),
                  escalatedTo: added
                    .map((a) => names.get(`person:${a.personId}`) ?? 'their manager')
                    .join(', '),
                  reviewUrl: `${options.publicUrl ?? ''}/govern/reviews?campaign=${campaign.id}`,
                },
                requestId: null,
                userId: recipient.userId,
              })),
            );
            raised += 1;
          }
        }

        return { sent, raised };
      });

      reminded += outcome.sent;
      escalated += outcome.raised;
    }
  }

  return { reminded, escalated };
}

/**
 * At `dueAt`, undecided items become `undecided` — TERMINAL — and the campaign
 * closes `incomplete`. Silence never certifies and silence never revokes: both
 * are refused, and refusing both is what makes the coverage figure the honest
 * headline.
 */
export async function closeDueCampaigns(
  tenantId: string,
  options: { now?: Date; publicUrl?: string; batchSize?: number } = {},
): Promise<{ closed: number; undecided: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? REVIEWER_BATCH;
  let closed = 0;
  let undecidedTotal = 0;

  // A SHORT TRANSACTION RETURNING PLAIN DATA, not a transaction held open
  // across every campaign and every item. §17 contemplates 50,000-item
  // campaigns; one `withTenant` over a 1,840-item campaign is roughly 5,500
  // round trips inside a 5000 ms budget.
  const due = await withTenant(tenantId, (tx) =>
    tx.campaign.findMany({
      where: { status: 'open', dueAt: { lte: now } },
      select: { id: true, name: true, ownerPersonId: true, snapshotId: true },
    }),
  );
  const settings = await withTenant(tenantId, (tx) => governSettings(tx));

  for (const campaign of due) {
    // ---- mark the undecided, batchSize items per transaction ---------------
    let undecided = 0;
    const silentReviewers = new Set<string>();
    for (;;) {
      const page = await withTenant(tenantId, (tx) =>
        tx.campaignItem.findMany({
          where: { campaignId: campaign.id, status: { in: ['pending', 'blocked_no_reviewer'] } },
          include: { reviewers: { where: { unassignedAt: null }, select: { personId: true } } },
          take: batchSize,
          orderBy: { id: 'asc' },
        }),
      );
      if (page.length === 0) break;

      await withTenant(tenantId, async (tx) => {
        await tx.campaignItem.updateMany({
          where: { id: { in: page.map((i) => i.id) } },
          data: {
            status: 'undecided',
            statusReason: 'the campaign closed and nobody decided this item. It was NOT attested.',
          },
        });
        for (const item of page) {
          await createRemediationItem(tx, tenantId, {
            kind: 'undecided_item',
            ownerPersonId: campaign.ownerPersonId,
            dueAt: new Date(now.getTime() + 14 * 86_400_000),
            campaignItemId: item.id,
            description: `${item.resourceName} for ${item.subjectKey} was not decided in "${campaign.name}". Somebody has to decide it by hand.`,
            deepLink: `/admin/govern/campaigns/${campaign.id}`,
          });
        }
      });

      for (const item of page) {
        for (const reviewer of item.reviewers) silentReviewers.add(reviewer.personId);
      }
      undecided += page.length;
      // The page's items are no longer `pending`, so the same query returns the
      // next page without needing a cursor.
    }

    // ---- the counts, computed from what they are DEFINED as ----------------
    //
    // §12: `coveragePercent = (decided + moot) / total` where `decided` is
    // EVERY ITEM CARRYING A CampaignDecision. Deriving it from statuses instead
    // omits the four `revocation_*` outcome statuses, so a campaign that
    // dispatched 91 revocations reports them as uncovered.
    //
    // And `revoked` is items whose LATEST decision is `revoke`, not items whose
    // status begins with the letters "revoke". `'revocation_dispatched'
    // .startsWith('revoke')` is FALSE — "revocation" begins "revoca" — so a
    // string test matches `revoke_decided` alone while explicitly including
    // `revocation_requires_change`, which the vocabulary rule says is NEVER
    // counted in a revoked figure and which §13 calls "a lie with a signature
    // on it".
    const counts = await withTenant(tenantId, async (tx) => {
      const total = await tx.campaignItem.count({ where: { campaignId: campaign.id } });
      const moot = await tx.campaignItem.count({
        where: { campaignId: campaign.id, status: 'moot' },
      });
      const requiresChange = await tx.campaignItem.count({
        where: { campaignId: campaign.id, status: 'revocation_requires_change' },
      });

      const decidedGroups = await tx.campaignDecision.groupBy({
        by: ['itemId'],
        where: { item: { campaignId: campaign.id } },
        _max: { decidedAt: true },
      });
      const decided = decidedGroups.length;

      // The LATEST decision per item decides which side of the line it is on.
      // An item revoked and then re-certified on appeal is certified. Ordered
      // ascending and overwritten, because `CampaignDecision` is append-only
      // and `sessionDecisionOrdinal` is per session rather than per item.
      const history = await tx.campaignDecision.findMany({
        where: { item: { campaignId: campaign.id } },
        select: { itemId: true, decision: true },
        orderBy: { decidedAt: 'asc' },
      });
      const decisionByItem = new Map<string, string>();
      for (const row of history) decisionByItem.set(row.itemId, row.decision);
      let certified = 0;
      let revoked = 0;
      for (const decision of decisionByItem.values()) {
        if (decision === 'certify') certified += 1;
        if (decision === 'revoke') revoked += 1;
      }

      return { total, moot, requiresChange, decided, certified, revoked };
    });

    const coverage =
      counts.total === 0
        ? 0
        : Math.round(((counts.decided + counts.moot) / counts.total) * 1000) / 10;

    await withTenant(tenantId, async (tx) => {
      await tx.campaign.update({
        where: { id: campaign.id },
        data: {
          status: undecided === 0 ? 'closed_complete' : 'closed_incomplete',
          certifiedItems: counts.certified,
          revokedItems: counts.revoked,
          requiresChangeItems: counts.requiresChange,
          mootItems: counts.moot,
          undecidedItems: undecided,
          totalItems: counts.total,
          coveragePercent: coverage,
        },
      });

      await recordEvent(tx, {
        actorUserId: null,
        action: 'govern.campaign.close',
        targetType: 'Campaign',
        targetId: campaign.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          certified: counts.certified,
          revoked: counts.revoked,
          requiresChange: counts.requiresChange,
          moot: counts.moot,
          undecided,
          decided: counts.decided,
          total: counts.total,
          coveragePercent: coverage,
        },
      });
    });

    if (coverage < settings.minimumCoveragePercent) {
      // The point of a recertification programme is not the certifications; it
      // is knowing which parts of the organization are not looking.
      //
      // `upsertFindings`, never `reconcileFindings`: this caller computes ONE
      // draft, and a whole-tenant sweep from here would close everything else
      // that is open.
      await upsertFindings(
        tenantId,
        [
          {
            kind: 'campaign_low_coverage',
            severity: 'high',
            subjectRefType: 'campaign',
            subjectRefId: campaign.id,
            detail: {
              campaignName: campaign.name,
              coveragePercent: coverage,
              minimum: settings.minimumCoveragePercent,
              certified: counts.certified,
              revoked: counts.revoked,
              requiresChange: counts.requiresChange,
              moot: counts.moot,
              undecided,
              decided: counts.decided,
              total: counts.total,
              reviewers: [...silentReviewers],
            },
          },
        ],
        { now },
      );
    }

    // §12's reviewer-quality section is "not hidden behind a toggle", so the
    // signals are computed at close rather than only when somebody asks.
    await computeReviewQualitySignals(tenantId, campaign.id, now);

    closed += 1;
    undecidedTotal += undecided;
  }

  return { closed, undecided: undecidedTotal };
}

export interface ReviewerResolutionPreview {
  resolved: number;
  viaFallback: number;
  blocked: number;
  /** Named, not counted. A count of 17 unreviewable items is not actionable. */
  blockedSample: { subjectKey: string; resourceName: string; reason: string }[];
}

/**
 * Bounded: it samples at most this many holdings, because a preview that takes
 * four minutes over 50,000 items is a screen nobody opens.
 */
export const PREVIEW_LIMIT = 2_000;

/**
 * A DRY RUN of `resolveItemReviewers` over a scope, before any item exists.
 *
 * §20 asks for the screen in words: "stage: manager; 1,102 items resolve, 61
 * fall to the fallback, 17 resolve to nobody — here they are", which is the
 * screen that catches an unreviewable campaign before 200 people are emailed
 * rather than at 3am on the due date.
 *
 * It duplicates no resolution logic: it builds the same `StageSnapshot` and the
 * same `ResolutionSubject` and calls the same `resolveStageApprovers`. What it
 * does not do is WRITE, which is the whole point — this runs against a campaign
 * that is still a draft, and a preview that generated items would be a campaign
 * nobody started.
 */
export async function previewReviewerResolution(
  tenantId: string,
  input: {
    scope: unknown;
    reviewerSelector: string;
    reviewerConfig: Record<string, unknown>;
    fallbackSelector: string;
    fallbackConfig: Record<string, unknown>;
    snapshotId?: string;
  },
): Promise<ReviewerResolutionPreview> {
  const now = new Date();
  const stage = stageFor({
    reviewerSelector: input.reviewerSelector,
    reviewerConfig: input.reviewerConfig,
    fallbackSelector: input.fallbackSelector,
    fallbackConfig: input.fallbackConfig,
  });

  const scope = input.scope as {
    resourceKinds?: string[];
    systemIds?: string[];
    privilegedOnly?: boolean;
  };

  const holdings = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    return tx.holding.findMany({
      where: {
        snapshotId: snapshot.id,
        ...(scope.resourceKinds === undefined
          ? {}
          : { resourceKind: { in: scope.resourceKinds } }),
        ...(scope.systemIds === undefined ? {} : { systemId: { in: scope.systemIds } }),
        ...(scope.privilegedOnly === true ? { privileged: true } : {}),
      },
      select: {
        subjectKey: true,
        personId: true,
        systemId: true,
        resourceKind: true,
        resourceId: true,
        resourceName: true,
      },
      take: PREVIEW_LIMIT,
      orderBy: { id: 'asc' },
    });
  });

  let resolved = 0;
  let viaFallback = 0;
  let blocked = 0;
  const blockedSample: ReviewerResolutionPreview['blockedSample'] = [];

  for (let i = 0; i < holdings.length; i += REVIEWER_BATCH) {
    const batch = holdings.slice(i, i + REVIEWER_BATCH);
    await withTenant(tenantId, async (tx) => {
      for (const holding of batch) {
        const subject = subjectFor(holding);
        const result =
          subject === null
            ? fallbackOnly(stage)
            : await resolveStageApprovers(tx, stage, subject, now);

        if (result.approvers.length === 0) {
          blocked += 1;
          if (blockedSample.length < 25) {
            blockedSample.push({
              subjectKey: holding.subjectKey,
              resourceName: holding.resourceName,
              reason:
                subject === null
                  ? 'this holding belongs to an account with no person, and the fallback is not a named person'
                  : 'the selector and the fallback both resolved to nobody who may decide it',
            });
          }
          continue;
        }
        resolved += 1;
        if (result.usedFallback) viaFallback += 1;
      }
    });
  }

  return { resolved, viaFallback, blocked, blockedSample };
}
