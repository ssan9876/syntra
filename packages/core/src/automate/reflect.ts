import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PROVISION_JOB, provisionJobPayload } from '../provision/jobs.js';
import { automateSettings } from './catalog-service.js';
import {
  displayNames,
  enqueueOutbox,
  nameList,
  recipientsForPersons,
  usersWithPermission,
} from './notify.js';
import { requestUrl } from './fulfil.js';
import type { RequestStatus, ResourceType } from './types.js';

export interface ReflectOptions {
  now?: Date;
  scheduler?: Scheduler | null;
  publicUrl?: string;
  /** Rows per transaction. See `REFLECT_BATCH`. */
  batchSize?: number;
}

/**
 * How many `RequestItem` rows one transaction reflects.
 *
 * `withTenant` is `prisma.$transaction` with Prisma's **5000 ms** default and
 * no `transactionOptions` on the client. Each item is roughly five queries and
 * each touched request writes an audit event, resolves display names and, on a
 * failure, reads `usersWithPermission`. This pass runs on the five-minute
 * tick, so a tenant-sized pass in one transaction is a P2028 every five
 * minutes. Every phase derives its state from the rows rather than from what
 * it did last time, so a batch that fails is redone on the next tick.
 */
const REFLECT_BATCH = 100;

/** Splits a work list into transaction-sized batches. */
function reflectChunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}

export interface ReflectResult {
  linked: number;
  fulfilled: number;
  failed: number;
  redispatched: number;
  slaAlerts: number;
}

/**
 * The Provision action statuses that will not change again.
 *
 * `superseded` is deliberately absent. A superseded action means a newer run
 * replaced this one; the grant is still in desired state, so the newer run
 * re-proposes it. That is the case that looks like a failure and is not.
 */
export const TERMINAL_ACTION_STATUSES: readonly string[] = [
  'applied',
  'failed',
  'skipped',
  'conflict',
];

const NON_TERMINAL_RUN_STATUSES = ['running', 'previewed', 'blocked', 'applying'];

/**
 * Reads what Provision did and moves the grants and requests to match.
 *
 * Idempotent by construction: it derives every state from the rows rather than
 * from what it did last time, so running it twice, or after a crash, or on a
 * schedule while a run is in flight, all produce the same answer.
 */
export async function reflectProvisionOutcomes(
  tenantId: string,
  options: ReflectOptions = {},
): Promise<ReflectResult> {
  const now = options.now ?? new Date();
  const publicUrl = options.publicUrl ?? '';
  const batchSize = options.batchSize ?? REFLECT_BATCH;

  const result: ReflectResult = {
    linked: 0,
    fulfilled: 0,
    failed: 0,
    redispatched: 0,
    slaAlerts: 0,
  };
  const touchedRequestIds = new Set<string>();
  const targetsToRun = new Set<string>();

  // ---- Phase 1: settings, and the item work list. ------------------------
  //
  // Four passes, each in its own transaction and each batched. An earlier
  // draft ran the lot inside one `withTenant`: every `dispatched` item at
  // roughly five queries, then every touched request with a
  // `usersWithPermission` apiece. `withTenant` is `prisma.$transaction` with
  // Prisma's **5000 ms** default, and this pass runs on the five-minute tick.
  // Every phase derives its state from the rows rather than from what it did
  // last time, so a batch that fails is redone on the next tick.
  const settings = await withTenant(tenantId, (tx) => automateSettings(tx));

  // `failed` as well as `dispatched`.
    //
    // The comment on the failure branch below says "the grant is NOT moved to
    // active, and it is NOT ended either: it is still in desired state, so a
    // fixed target converges on the next run without anybody raising a second
    // request." That is only true if this pass looks at the item again. Query
    // `dispatched` alone and a failed item leaves the set permanently: the
    // grant stays `pending` forever, the request stays `fulfilment_failed`,
    // and the person's access becomes real on the next run with nothing
    // saying so.
    const itemIds = await withTenant(tenantId, async (tx) =>
      (
        await tx.requestItem.findMany({
          where: { status: { in: ['dispatched', 'failed'] }, resourceType: 'entitlement' },
          select: { id: true },
        })
      ).map((row) => row.id),
    );

    // ---- Phase 2: reflect each item. ------------------------------------
    for (const batch of reflectChunk(itemIds, batchSize)) {
     await withTenant(tenantId, async (tx) => {
      const items = await tx.requestItem.findMany({ where: { id: { in: batch } } });

      for (const item of items) {
        touchedRequestIds.add(item.requestId);

      // Link the action if it has not been linked. The action carries the
      // grant id Provision wrote at plan time, so the join needs no guessing.
      let actionId = item.provisionActionId;
      // A `failed` item re-links to the NEWEST action for its grant, not to
      // the one that failed: a later run planned the same grant again, and
      // that later action is what says whether the target converged. Without
      // the re-link a failed item is pinned to its failure forever.
      const wantsRelink =
        actionId === null || (item.status === 'failed' && item.grantId !== null);
      if (wantsRelink && item.grantId !== null) {
        const action = await tx.provisionAction.findFirst({
          where: { grantId: item.grantId, actionType: 'grant_entitlement' },
          orderBy: { createdAt: 'desc' },
        });
        if (action !== null && action.id !== item.provisionActionId) {
          actionId = action.id;
          await tx.requestItem.update({
            where: { id: item.id },
            data: { provisionActionId: action.id },
          });
          result.linked += 1;
        }
      }

      if (actionId === null) {
        // Approved, dispatched, and no run has ever planned it. Either the
        // enqueue never happened or it happened and the run has not started.
        if (item.targetSystemId !== null) targetsToRun.add(item.targetSystemId);
        continue;
      }

      const action = await tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } });

      if (action.status === 'superseded') {
        // Not a failure. Unlink so the next run's action is picked up, and ask
        // for a run in case none is pending.
        await tx.requestItem.update({
          where: { id: item.id },
          data: { provisionActionId: null },
        });
        if (item.targetSystemId !== null) targetsToRun.add(item.targetSystemId);
        continue;
      }

      if (!TERMINAL_ACTION_STATUSES.includes(action.status)) continue;

      if (action.status === 'applied') {
        await tx.requestItem.update({
          where: { id: item.id },
          data: { status: 'fulfilled', message: null },
        });
        if (item.grantId !== null) {
          await tx.accessGrant.update({
            where: { id: item.grantId },
            data: { status: 'active' },
          });
        }
        result.fulfilled += 1;
      } else {
        await tx.requestItem.update({
          where: { id: item.id },
          // The target's own message. Replacing it with a generic one throws
          // away the only thing that tells an administrator what to fix.
          data: { status: 'failed', message: action.message ?? action.status },
        });
        // The grant is NOT moved to active, and it is NOT ended either: it is
        // still in desired state, so a fixed target converges on the next run
        // without anybody raising a second request.
        result.failed += 1;
      }
      }
     });
  }

  // ---- Phase 3: the requests those items belong to. ----------------------
  //
  // Recomputed from the items rather than accumulated, which is what lets a
  // request that failed once and succeeded later end up `fulfilled`. One
  // request per transaction: each writes an audit event, resolves display
  // names and, on a failure, reads `usersWithPermission`.
  for (const requestId of touchedRequestIds) {
    await withTenant(tenantId, async (tx) => {
      const request = await tx.accessRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { items: true, product: true },
      });
      const inFlight = request.items.some(
        (i) => i.status === 'pending' || i.status === 'dispatched',
      );
      const landed = request.items.some((i) => i.status === 'fulfilled');
      const failed = request.items.some((i) => i.status === 'failed');

      const status: RequestStatus = inFlight
        ? 'awaiting_fulfilment'
        : failed && landed
          ? 'partially_fulfilled'
          : failed
            ? 'fulfilment_failed'
            : 'fulfilled';
      if (status === request.status) return;

      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status, ...(inFlight ? {} : { fulfilledAt: now }) },
      });
      await recordEvent(tx, {
        actorUserId: null,
        action: 'automate.request.reflect',
        targetType: 'AccessRequest',
        targetId: requestId,
        outcome: status === 'fulfilment_failed' ? 'failure' : 'success',
        sourceIp: null,
        payload: { from: request.status, to: status },
      });

      const recipients = await recipientsForPersons(tx, [
        request.subjectPersonId,
        ...(request.requestedByPersonId === null ? [] : [request.requestedByPersonId]),
      ]);
      const managers =
        status === 'fulfilled'
          ? []
          : await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      const template =
        status === 'fulfilled'
          ? ('automate-fulfilled' as const)
          : status === 'partially_fulfilled'
            ? ('automate-partially-fulfilled' as const)
            : ('automate-fulfilment-failed' as const);
      if (status === 'awaiting_fulfilment') return;

      const failedMessages = request.items
        .filter((i) => i.status === 'failed')
        .map((i) => i.message ?? 'no message')
        .join('; ');
      // Names. `targetName: request.items[0]?.targetSystemId` and a
      // `resourceList` of raw `resourceId`s put three UUIDs into a mail whose
      // whole job (spec section 13) is to say "what did not land, and why".
      const names = await displayNames(tx, {
        personIds: [request.subjectPersonId],
        productIds: request.productId === null ? [] : [request.productId],
        resources: request.items.map((i) => ({
          resourceType: i.resourceType as ResourceType,
          resourceId: i.resourceId,
        })),
      });
      const describe = (predicate: (status: string) => boolean) =>
        nameList(
          names,
          request.items
            .filter((i) => predicate(i.status))
            .map((i) => ({
              resourceType: i.resourceType as ResourceType,
              resourceId: i.resourceId,
            })),
        );
      const firstTargetId = request.items.find((i) => i.targetSystemId !== null)?.targetSystemId;
      const targetName =
        firstTargetId === undefined || firstTargetId === null
          ? 'no target system'
          : ((
              await tx.targetSystem.findUnique({
                where: { id: firstTargetId },
                select: { name: true },
              })
            )?.name ?? 'a target system');
      await enqueueOutbox(
        tx,
        [...recipients, ...managers].map((r) => ({
          template,
          to: r.email,
          vars: {
            displayName: r.displayName,
            productName: request.product?.name ?? 'the requested access',
            subjectName:
              names.get(`person:${request.subjectPersonId}`) ?? 'the person this was for',
            targetName,
            message: failedMessages,
            grantedList: describe((status) => status === 'fulfilled'),
            failedList: describe((status) => status === 'failed'),
            resourceList: describe(() => true),
            endsAt: '',
            skippedNote: '',
            requestUrl: requestUrl(publicUrl, requestId),
          },
          requestId,
          userId: r.userId,
        })),
      );
    });
  }

  // ---- Phase 4: the fulfilment SLA. --------------------------------------
  //
  // A request approved and not applied is not an error; it becomes one when
  // nobody has looked at it for a day. One transaction per stale request:
  // each one reads `usersWithPermission`.
  const slaCutoff = new Date(now.getTime() - settings.fulfilmentSlaHours * 3_600_000);
  const staleIds = await withTenant(tenantId, async (tx) =>
    (
      await tx.accessRequest.findMany({
        where: { status: 'awaiting_fulfilment', dispatchedAt: { lt: slaCutoff } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  for (const staleId of staleIds) {
    await withTenant(tenantId, async (tx) => {
      const request = await tx.accessRequest.findUniqueOrThrow({
        where: { id: staleId },
        include: { product: true, items: true },
      });
      // Once per request, not once per tick. Deduped on the outbox itself,
      // which is also the row somebody reads when they ask whether they were
      // ever told.
      const alreadyWarned = await tx.notificationOutbox.count({
        where: { requestId: request.id, template: 'automate-awaiting-fulfilment-sla' },
      });
      if (alreadyWarned > 0) return;

      const managers = await usersWithPermission(tx, PERMISSIONS.AUTOMATE_MANAGE);
      if (managers.length === 0) return;
      const staleNames = await displayNames(tx, {
        personIds: [request.subjectPersonId],
      });
      const staleTargetId = request.items.find((i) => i.targetSystemId !== null)?.targetSystemId;
      const staleTargetName =
        staleTargetId === undefined || staleTargetId === null
          ? 'no target system'
          : ((
              await tx.targetSystem.findUnique({
                where: { id: staleTargetId },
                select: { name: true },
              })
            )?.name ?? 'a target system');
      await enqueueOutbox(
        tx,
        managers.map((r) => ({
          template: 'automate-awaiting-fulfilment-sla' as const,
          to: r.email,
          vars: {
            displayName: r.displayName,
            productName: request.product?.name ?? 'the requested access',
            subjectName:
              staleNames.get(`person:${request.subjectPersonId}`) ?? 'the person this was for',
            targetName: staleTargetName,
            waitingHours: String(settings.fulfilmentSlaHours),
            requestUrl: requestUrl(publicUrl, request.id),
          },
          requestId: request.id,
          userId: r.userId,
        })),
      );
      result.slaAlerts += 1;
    });
  }

  // ---- Phase 5: which targets actually need a run. -----------------------
  //
  // Only where no run is already in flight for that target. Provision refuses
  // a second concurrent run anyway, and an enqueue per tick would fill the
  // queue with jobs that immediately skip.
  const needsRun = await withTenant(tenantId, async (tx) => {
    const out: string[] = [];
    for (const targetSystemId of targetsToRun) {
      const inFlight = await tx.provisionRun.count({
        where: { targetSystemId, status: { in: NON_TERMINAL_RUN_STATUSES } },
      });
      if (inFlight === 0) out.push(targetSystemId);
    }
    return out;
  });
  result.redispatched = needsRun.length;

  // Outside every transaction: `Scheduler.enqueue` is `boss.send` on
  // pg-boss's own pool and neither joins a transaction nor rolls back with one.
  for (const targetSystemId of needsRun) {
    await options.scheduler?.enqueue(
      PROVISION_JOB,
      provisionJobPayload(tenantId, targetSystemId),
    );
  }

  return result;
}
