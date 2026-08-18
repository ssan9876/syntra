import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { assignApplication } from '../access/assignment-service.js';
import { resolveApplicationIdsForUser } from '../access/resolve.js';
import { addMember } from '../directory/group-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PROVISION_JOB, provisionJobPayload } from '../provision/jobs.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import {
  displayNames,
  enqueueOutbox,
  nameList,
  recipientsForPersons,
  usersWithPermission,
} from './notify.js';
import { checkEligibility } from './eligibility.js';
import { grantWindow } from './duration.js';
import { LIVE_GRANT_STATUSES, type RequestStatus, type ResourceType } from './types.js';

export interface FulfilOptions {
  now?: Date;
  /**
   * How a Provision run is enqueued. Null or absent means no enqueue, which
   * is what every test that is not about scheduling wants -- and which
   * reflection recovers from anyway.
   */
  scheduler?: Scheduler | null;
  publicUrl?: string;
}

export interface FulfilOutcome {
  status: RequestStatus;
  grantIds: string[];
  targetSystemIds: string[];
}

export function requestUrl(publicUrl: string, requestId: string): string {
  return `${publicUrl.replace(/\/$/, '')}/requests/${requestId}`;
}

/**
 * What the subject already holds, and where each holding came from.
 *
 * Keyed on `resourceType:resourceId`. A person who asks for something they
 * already have has a different problem and deserves to be told what it is, so
 * the SOURCE travels with the answer rather than a bare boolean.
 */
export async function subjectHoldings(
  tx: TenantClient,
  personId: string,
): Promise<Map<string, { source: 'rule' | 'request' | 'manual' | 'discovered'; detail: string }>> {
  const out = new Map<
    string,
    { source: 'rule' | 'request' | 'manual' | 'discovered'; detail: string }
  >();

  const holdings = await tx.accountEntitlement.findMany({
    where: { state: 'held', account: { personId } },
    include: { entitlement: { select: { displayName: true } } },
  });
  for (const holding of holdings) {
    out.set(`entitlement:${holding.entitlementId}`, {
      source: holding.origin as 'rule' | 'request' | 'manual' | 'discovered',
      detail: holding.entitlement.displayName,
    });
  }

  const users = await tx.user.findMany({
    where: { personId, status: 'active' },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    // EFFECTIVE assignments, resolved the way Access's portal tile resolver
    // resolves them: `resolveApplicationIdsForUser` unions assignments naming
    // the user, assignments naming a group they belong to, and assignments
    // naming their org unit or one above it.
    //
    // Reading only `userId` misses a person who already has the application
    // through their group: the request is granted a second time, a
    // user-scoped assignment is created beside the group one, and on hand-back
    // only the user-scoped row is deleted -- so the person keeps the app and
    // it reads as a failed revocation.
    //
    // **Counted per account, and "held" means EVERY active account has it.**
    // The fulfilment loop writes to every account the person holds, so a
    // person-level "any account has this" test does not match what the write
    // does: somebody whose second login happens to sit in the reading room
    // could never be granted the reading room on their primary one -- the item
    // is skipped as already held, no grant row is written, and the access they
    // asked for never arrives on the account they actually use. It also
    // silently defeats `writtenRowIds`: with no grant there is nothing to own
    // the rows, and nothing to remove them later.
    const applicationHolders = new Map<string, number>();
    const groupHolders = new Map<string, number>();
    const count = (into: Map<string, number>, id: string) =>
      into.set(id, (into.get(id) ?? 0) + 1);

    for (const userId of userIds) {
      for (const id of await resolveApplicationIdsForUser(tx, userId)) {
        count(applicationHolders, id);
      }
    }
    const memberships = await tx.groupMembership.findMany({
      where: { userId: { in: userIds } },
      select: { groupId: true },
    });
    for (const membership of memberships) count(groupHolders, membership.groupId);

    for (const [applicationId, holders] of applicationHolders) {
      if (holders < userIds.length) continue;
      out.set(`application:${applicationId}`, {
        source: 'manual',
        detail: 'an existing assignment',
      });
    }
    for (const [groupId, holders] of groupHolders) {
      if (holders < userIds.length) continue;
      out.set(`group:${groupId}`, {
        source: 'manual',
        detail: 'an existing membership',
      });
    }
  }

  // A live grant counts even where the write has not landed yet, so a second
  // request for the same thing is skipped rather than racing the first.
  const grants = await tx.accessGrant.findMany({
    where: { subjectPersonId: personId, status: { in: [...LIVE_GRANT_STATUSES] } },
    select: { resourceType: true, resourceId: true, requestId: true },
  });
  for (const grant of grants) {
    out.set(`${grant.resourceType}:${grant.resourceId}`, {
      source: 'request',
      detail: 'an earlier request',
    });
  }

  return out;
}

/**
 * Turns an approved request into the access it asked for.
 *
 * One short transaction. Every write is a database write against a table with
 * no other writer, or an `AccessGrant` row that Provision will read. Nothing
 * here opens a socket, and the only remote call in the whole fulfilment path
 * belongs to Provision, inside Provision's own three-step shape.
 */
export async function fulfilRequest(
  tenantId: string,
  requestId: string,
  options: FulfilOptions = {},
): Promise<FulfilOutcome> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';

  const outcome = await withTenant(tenantId, async (tx): Promise<FulfilOutcome> => {
    const request = await tx.accessRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { items: true, product: true },
    });

    // The only statuses from which fulfilment is legitimate.
    //
    // Not a defensive check: this is the LAST place the approval control is
    // enforceable, and a grant produced from a rejected request is
    // indistinguishable in the inventory from one somebody approved. The item
    // filter below is `status === 'pending'`, which is exactly what a
    // never-approved request and a rejected one both look like, so without
    // this guard any caller holding a request id bypasses approval entirely.
    // "There is no path to a grant that does not pass approval" is the claim
    // this slice exists to make; it must not rest on nobody adding a caller.
    if (request.status !== 'approved' && request.status !== 'awaiting_fulfilment') {
      throw new Error(`request ${requestId} is ${request.status}, not approved`);
    }

    // Re-checked HERE as well as at each stage (spec section 4: "re-evaluated
    // at each stage and again at fulfilment"). The decision path happens to
    // check it in its own transaction just before writing `approved`, so the
    // common case is covered by accident -- but the auto-grant path checks at
    // the top of `submitRequest` and then fulfils in a separate transaction
    // after it commits, and that is the one path with no human on it.
    if (request.productId !== null) {
      const eligibility = await checkEligibility(
        tx,
        request.productId,
        request.subjectPersonId,
        now,
      );
      if (!eligibility.ok) {
        await tx.accessRequest.update({
          where: { id: requestId },
          data: {
            status: 'rejected',
            statusReason: `${eligibility.reason}: ${eligibility.message}`,
            decidedAt: now,
          },
        });
        await tx.requestItem.updateMany({
          where: { requestId, status: 'pending' },
          data: { status: 'skipped', message: eligibility.message },
        });
        await recordEvent(tx, {
          actorUserId: null,
          action: 'automate.request.auto_refuse',
          targetType: 'AccessRequest',
          targetId: requestId,
          outcome: 'success',
          sourceIp: null,
          payload: { reason: eligibility.reason, at: 'fulfilment' },
        });
        const told = await recipientsForPersons(tx, [
          request.subjectPersonId,
          ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
        ]);
        const refusedNames = await displayNames(tx, {
          personIds: [request.subjectPersonId],
        });
        await enqueueOutbox(
          tx,
          told.map((r) => ({
            template: 'automate-refused' as const,
            to: r.email,
            vars: {
              displayName: r.displayName,
              productName: request.product?.name ?? 'the requested access',
              subjectName:
                refusedNames.get(`person:${request.subjectPersonId}`) ?? 'the subject',
              reason: eligibility.message,
              requestUrl: requestUrl(publicUrl, request.id),
            },
            requestId: request.id,
            userId: r.userId,
          })),
        );
        return { status: 'rejected', grantIds: [], targetSystemIds: [] };
      }
    }

    const held = await subjectHoldings(tx, request.subjectPersonId);

    // An extension is a new request against the same product, and the grant
    // it replaces is NOT "already held" for the purpose of skipping it --
    // that is the whole point of extending. Without this the item is marked
    // `skipped`, the request is reported `fulfilled`, the requester is
    // emailed that they hold it, no new grant exists, and the access goes
    // away on the original date. Spec section 12 calls the naive
    // implementation "an outage and two audit events that say the opposite of
    // what happened"; silently losing it is worse.
    const replacedGrant =
      request.replacesGrantId === null
        ? null
        : await tx.accessGrant.findFirst({
            where: {
              id: request.replacesGrantId,
              subjectPersonId: request.subjectPersonId,
              status: { in: [...LIVE_GRANT_STATUSES] },
            },
          });
    if (replacedGrant !== null) {
      held.delete(`${replacedGrant.resourceType}:${replacedGrant.resourceId}`);
    }

    const users = await tx.user.findMany({
      where: { personId: request.subjectPersonId, status: 'active' },
      select: { id: true },
    });

    // Read once, for the vars every template below renders. Spec section 13
    // requires each of these to NAME things; an id in a mail is a support
    // ticket nobody can answer.
    const names = await displayNames(tx, {
      personIds: [
        request.subjectPersonId,
        ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
      ],
      productIds: request.productId === null ? [] : [request.productId],
      resources: request.items.map((item) => ({
        resourceType: item.resourceType as ResourceType,
        resourceId: item.resourceId,
      })),
    });

    // The last approving decision, so the expiry warning and the lapse notice
    // can reach the person who allowed this without walking the steps. Null
    // for an auto-granted product and for a delegated act, which is correct:
    // nobody approved either.
    const lastApproval = await tx.approvalDecision.findFirst({
      where: { step: { requestId: request.id }, decision: 'approve' },
      orderBy: { decidedAt: 'desc' },
      select: { personId: true },
    });

    // The duration was resolved at submission and possibly shortened at the
    // decision; `requestedDurationDays` carries the answer. The window is
    // computed here because `startsAt` is the moment of fulfilment.
    const contracts = await tx.contract.findMany({
      where: { personId: request.subjectPersonId },
      orderBy: { startDate: 'asc' },
      select: { startDate: true },
    });
    const futureStart = contracts.find((c) => c.startDate > now)?.startDate ?? null;
    const earliestContractStart = contracts.some((c) => c.startDate <= now)
      ? null
      : futureStart;
    const window = grantWindow({
      now,
      days: request.requestedDurationDays,
      requestedStartsAt: null,
      earliestContractStart,
    });

    const grantIds: string[] = [];
    const targetSystemIds = new Set<string>();
    // Resource descriptors, not `"application:0f3e-..."` strings. These are
    // what the templates render, and `nameList` turns them into names.
    const granted: { resourceType: ResourceType; resourceId: string }[] = [];
    const skipped: { resourceType: ResourceType; resourceId: string }[] = [];
    const failed: { resourceType: ResourceType; resourceId: string }[] = [];

    for (const item of request.items) {
      if (item.status !== 'pending') continue;

      const key = `${item.resourceType}:${item.resourceId}`;
      const resource = {
        resourceType: item.resourceType as ResourceType,
        resourceId: item.resourceId,
      };
      const existing = held.get(key);
      if (existing !== undefined) {
        await tx.requestItem.update({
          where: { id: item.id },
          data: {
            status: 'skipped',
            message: `already held, from ${existing.detail}`,
          },
        });
        skipped.push(resource);
        continue;
      }

      if (item.resourceType !== 'entitlement' && users.length === 0) {
        // Refused at submission too, but a subject can lose their last account
        // between approval and fulfilment.
        await tx.requestItem.update({
          where: { id: item.id },
          data: { status: 'failed', message: 'the subject holds no active Syntra account' },
        });
        failed.push(resource);
        continue;
      }

      const superseded =
        replacedGrant !== null &&
        replacedGrant.resourceType === item.resourceType &&
        replacedGrant.resourceId === item.resourceId
          ? replacedGrant
          : null;

      // THE ORDER OF THESE THREE STATEMENTS IS FORCED BY THE DATABASE, NOT BY
      // STYLE. `access_grant_one_live` is an immediate, non-deferrable partial
      // unique index on (tenantId, subjectPersonId, resourceType, resourceId)
      // WHERE status IN ('scheduled','pending','active') -- exactly the four
      // columns the old row and the new row share. Create the replacement
      // while the old row is still `active` and the create raises P2002. So:
      // retire the old row first, so it leaves the index predicate; create the
      // replacement; then a SECOND update back-fills `supersededByGrantId`,
      // which cannot be set in the first update because the id it needs does
      // not exist yet. All three are in the one transaction, so there is no
      // instant visible to any other transaction in which the person holds
      // neither -- that is spec section 12's "no outage". `endedAt` and
      // `supersededByGrantId` together are also what stop tonight's sweep
      // proposing a removal for a grant an approved extension already
      // replaced: Task 13's classifier skips any grant carrying it.
      if (superseded !== null) {
        await tx.accessGrant.update({
          where: { id: superseded.id },
          data: {
            status: 'revoked',
            statusReason: 'superseded by an approved extension',
            endedAt: now,
          },
        });
      }

      const grant = await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: request.subjectPersonId,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          targetSystemId: item.targetSystemId,
          origin: request.origin === 'delegated_admin' ? 'delegated_admin' : 'request',
          requestId: request.id,
          productId: request.productId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          // A target entitlement is `pending` until Provision confirms it. The
          // console never claims somebody holds something they do not.
          status: window.scheduled
            ? 'scheduled'
            : item.resourceType === 'entitlement'
              ? 'pending'
              : 'active',
          approvedByPersonId: lastApproval?.personId ?? null,
        },
      });
      grantIds.push(grant.id);

      if (superseded !== null) {
        await tx.accessGrant.update({
          where: { id: superseded.id },
          data: { supersededByGrantId: grant.id },
        });
      }

      if (item.resourceType === 'entitlement') {
        if (item.targetSystemId !== null) targetSystemIds.add(item.targetSystemId);
        await tx.requestItem.update({
          where: { id: item.id },
          data: { status: 'dispatched', grantId: grant.id },
        });
        granted.push(resource);
      } else {
        // Only the rows THIS grant creates are recorded, and only those are
        // deleted when it ends. Spec section 5's safety argument for Automate
        // writing `AppAssignment` and `GroupMembership` at all is that each
        // has exactly one other writer; deleting by (applicationId, userId)
        // breaks it in the other direction, taking out a membership an
        // administrator added by hand and reporting it as a grant that
        // lapsed. `assignApplication` and `addMember` are both idempotent and
        // return void, so the row is looked for first: if it was already
        // there, it is somebody else's and this grant does not own it.
        //
        // An extension INHERITS the rows the grant it replaces wrote. Without
        // this line the replacement records nothing: the "look first" guard
        // below finds the `AppAssignment` or `GroupMembership` already present
        // -- because the superseded grant created it, and superseding
        // deliberately does not delete it, which is the no-outage property --
        // and `continue`s. The row would then belong to a `revoked` grant, and
        // when the replacement itself expires Task 13's `applyExpirySweep`
        // deletes by `writtenRowIds`, finds none, and removes nothing: the
        // person keeps the application or the local group PERMANENTLY, under
        // an audit event saying the grant lapsed and a `SweepAction` marked
        // applied. The replacement is now the only live reason those rows
        // exist, so it owns them.
        const writtenRowIds: string[] =
          superseded === null ? [] : [...superseded.writtenRowIds];
        if (!window.scheduled) {
          for (const user of users) {
            if (item.resourceType === 'application') {
              const where = {
                applicationId: item.resourceId,
                userId: user.id,
                groupId: null,
                orgUnitId: null,
              };
              const before = await tx.appAssignment.findFirst({ where, select: { id: true } });
              if (before !== null) continue;
              await assignApplication(tx, item.resourceId, { type: 'user', id: user.id });
              const created = await tx.appAssignment.findFirst({ where, select: { id: true } });
              if (created !== null) writtenRowIds.push(created.id);
            } else {
              const membershipKey = { groupId: item.resourceId, userId: user.id };
              const before = await tx.groupMembership.findUnique({
                where: { groupId_userId: membershipKey },
                select: { id: true },
              });
              if (before !== null) continue;
              await addMember(tx, item.resourceId, user.id);
              const created = await tx.groupMembership.findUnique({
                where: { groupId_userId: membershipKey },
                select: { id: true },
              });
              if (created !== null) writtenRowIds.push(created.id);
            }
          }
        }
        // Outside the `window.scheduled` guard: a scheduled extension writes
        // no rows of its own yet but must still carry the inherited ones, and
        // Task 15's promotion pass appends to `grant.writtenRowIds` rather
        // than replacing it, so nothing is lost when it later goes active.
        if (writtenRowIds.length > 0) {
          await tx.accessGrant.update({
            where: { id: grant.id },
            data: { writtenRowIds },
          });
        }
        await tx.requestItem.update({
          where: { id: item.id },
          data: { status: 'fulfilled', grantId: grant.id },
        });
        granted.push(resource);
      }

      await recordEvent(tx, {
        actorUserId: request.requestedByUserId,
        action: 'automate.grant.create',
        targetType: 'AccessGrant',
        targetId: grant.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          requestId: request.id,
          subjectPersonId: request.subjectPersonId,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          startsAt: grant.startsAt.toISOString(),
          endsAt: grant.endsAt?.toISOString() ?? null,
          status: grant.status,
        },
      });
    }

    const items = await tx.requestItem.findMany({ where: { requestId } });
    const anyInFlight = items.some((i) => i.status === 'dispatched' || i.status === 'pending');
    const anyLanded = items.some((i) => i.status === 'fulfilled');
    const anyFailed = items.some((i) => i.status === 'failed');
    // Every item already held. `submitRequest` refuses that case up front, but
    // a request approved between the two checks reaches here, and reporting it
    // `fulfilled` with an empty resource list tells somebody they were given
    // something when nothing happened. Same status -- there is nothing wrong
    // -- with a reason that says what was already held.
    const allSkipped =
      items.length > 0 && items.every((i) => i.status === 'skipped');

    const status: RequestStatus = anyInFlight
      ? 'awaiting_fulfilment'
      : anyFailed && anyLanded
        ? 'partially_fulfilled'
        : anyFailed
          ? 'fulfilment_failed'
          : 'fulfilled';

    await tx.accessRequest.update({
      where: { id: requestId },
      data: {
        status,
        ...(allSkipped
          ? {
              statusReason: `already held: ${nameList(names, skipped)}`,
            }
          : {}),
        ...(anyInFlight ? { dispatchedAt: request.dispatchedAt ?? now } : {}),
        ...(status === 'fulfilled' || status === 'partially_fulfilled'
          ? { fulfilledAt: now }
          : {}),
      },
    });

    // Rendered here, sent by the outbox job afterwards. Nothing in this
    // function can reach a mail server.
    const recipients = await recipientsForPersons(tx, [
      request.subjectPersonId,
      ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
    ]);
    // Every var is a NAME. Spec section 13 requires each of these to name
    // things -- "names what they now hold and until when", "names what did
    // not land, and why" -- and a mail reading "guid-4f2a... holds
    // guid-91be... until Mon Jun 15 2026" satisfies none of it.
    const vars = {
      productName:
        request.productId === null
          ? 'the requested access'
          : (names.get(`product:${request.productId}`) ?? 'the requested access'),
      subjectName:
        names.get(`person:${request.subjectPersonId}`) ?? 'the person this was for',
      resourceList: nameList(names, granted),
      grantedList: nameList(names, granted),
      failedList: nameList(names, failed),
      endsAt: window.endsAt?.toDateString() ?? 'until it is taken away',
      skippedNote:
        skipped.length === 0
          ? ''
          : `Already held, so nothing changed for: ${nameList(names, skipped)}.`,
      requestUrl: requestUrl(publicUrl, request.id),
    };

    if (status === 'fulfilled') {
      await enqueueOutbox(
        tx,
        recipients.map((r) => ({
          template: 'automate-fulfilled' as const,
          to: r.email,
          vars: { ...vars, displayName: r.displayName },
          requestId: request.id,
          userId: r.userId,
        })),
      );
    } else if (status === 'partially_fulfilled' || status === 'fulfilment_failed') {
      const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      await enqueueOutbox(
        tx,
        [...recipients, ...managers].map((r) => ({
          template:
            status === 'partially_fulfilled'
              ? ('automate-partially-fulfilled' as const)
              : ('automate-fulfilment-failed' as const),
          to: r.email,
          vars: { ...vars, displayName: r.displayName, message: nameList(names, failed) },
          requestId: request.id,
          userId: r.userId,
        })),
      );
    }

    return { status, grantIds, targetSystemIds: [...targetSystemIds] };
  });

  // AFTER the commit, deliberately. `Scheduler.enqueue` is `boss.send` on
  // pg-boss's own pool, so it neither joins this transaction nor rolls back
  // with it -- and an approval undone because pg-boss was briefly unreachable
  // is a worse failure than a run enqueued a few minutes late. Task 12's
  // reflection pass re-enqueues for any target left holding a pending grant.
  for (const targetSystemId of outcome.targetSystemIds) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(tenantId, targetSystemId),
    );
  }

  return outcome;
}

async function endGrant(
  tenantId: string,
  actorUserId: string | null,
  grantId: string,
  status: 'revoked',
  reason: string,
  action: string,
  options: FulfilOptions,
): Promise<void> {
  const now = options.now ?? new Date();

  const targetSystemId = await withTenant(tenantId, async (tx) => {
    const grant = await tx.accessGrant.findUniqueOrThrow({ where: { id: grantId } });
    // Idempotent: a grant already out of force has nothing to give back, and
    // a second audit event would claim a second act.
    if (!(LIVE_GRANT_STATUSES as readonly string[]).includes(grant.status)) return null;

    await tx.accessGrant.update({
      where: { id: grantId },
      data: { status, statusReason: reason, endedAt: now },
    });

    // Deletes ONLY the rows this grant wrote.
    //
    // Spec section 5's safety argument for Automate writing `AppAssignment`
    // and `GroupMembership` at all is that each has exactly one other writer.
    // A delete keyed on (applicationId, userId) -- or `removeMember`, which is
    // keyed on (groupId, userId) -- breaks that argument in the other
    // direction: a membership an administrator added by hand after the grant
    // was made is removed when the grant ends, with an audit event saying the
    // grant lapsed. Anything not in `writtenRowIds` is somebody else's row and
    // is left alone, and the audit payload records that it was.
    let removed = 0;
    if (grant.resourceType !== 'entitlement' && grant.writtenRowIds.length > 0) {
      const deleted =
        grant.resourceType === 'application'
          ? await tx.appAssignment.deleteMany({
              where: { id: { in: grant.writtenRowIds } },
            })
          : await tx.groupMembership.deleteMany({
              where: { id: { in: grant.writtenRowIds } },
            });
      removed = deleted.count;
    }

    await recordEvent(tx, {
      actorUserId,
      action,
      targetType: 'AccessGrant',
      targetId: grantId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        subjectPersonId: grant.subjectPersonId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        reason,
        // Both numbers, so "the grant ended and nothing was removed" is
        // readable rather than inferred. They differ when an administrator
        // removed the row by hand first.
        rowsThisGrantWrote: grant.writtenRowIds.length,
        rowsRemoved: removed,
      },
    });

    return grant.resourceType === 'entitlement' ? grant.targetSystemId : null;
  });

  if (targetSystemId !== null) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(tenantId, targetSystemId),
    );
  }
}

/**
 * Somebody giving one thing back.
 *
 * Runs immediately rather than waiting for the nightly sweep, and is subject
 * to Provision's guard on the target side and to no sweep guard at all: a
 * guard exists to catch mass action, and this is one grant.
 */
export async function handBackGrant(
  tenantId: string,
  actorUserId: string | null,
  grantId: string,
  options: FulfilOptions = {},
): Promise<void> {
  await endGrant(
    tenantId,
    actorUserId,
    grantId,
    'revoked',
    'handed back by the holder',
    'automate.grant.hand_back',
    options,
  );
}

/** An owner or an administrator taking it away. Same mechanism, different act. */
export async function revokeGrant(
  tenantId: string,
  actorUserId: string | null,
  grantId: string,
  reason: string,
  options: FulfilOptions = {},
): Promise<void> {
  await endGrant(
    tenantId,
    actorUserId,
    grantId,
    'revoked',
    reason,
    'automate.grant.revoke',
    options,
  );
}
