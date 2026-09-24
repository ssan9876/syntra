import type { TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import {
  honouredCancellation,
  requestCancellation,
  type CancelResult,
  type CancellableRunDelegate,
} from '../jobs/cancellation.js';

/*
 * Cancellation for provisioning runs, beside rather than inside
 * `run-service.ts` and `apply.ts`: both need it, and `run-service.ts` already
 * imports from `apply.ts`, so either home would make the pair circular.
 * The state machine itself is `jobs/cancellation.ts`.
 */

/** `ProvisionRun` narrowed to the shape `jobs/cancellation.ts` works on. */
export const cancellableRuns = (tx: TenantClient) =>
  tx.provisionRun as unknown as CancellableRunDelegate;

/**
 * Written on every action a cancellation left unapplied. `superseded` is the
 * status, because it already means what a cancelled action means to every
 * reader of this table: a newer run re-proposes it if it is still desired, and
 * Automate's reflection unlinks the request item rather than failing it.
 */
export const CANCELLED_ACTION_MESSAGE = 'not attempted: the run was cancelled';

/**
 * Marks what a cancelled run never attempted, and re-opens the revocation
 * orders those actions were carrying.
 *
 * Phase 7 moves an order to `planned` when a plan consumes it, so the next run
 * does not propose it twice. An order whose only action was abandoned here
 * would otherwise stay `planned` for ever, and `loadRevocationOrders` reads
 * only `open` ones: a campaign's decision to remove access would silently
 * never happen.
 */
export async function abandonProposedActions(tx: TenantClient, runId: string): Promise<number> {
  const abandoned = await tx.provisionAction.findMany({
    where: { runId, status: 'proposed' },
    select: { id: true, revocationOrderId: true },
  });
  if (abandoned.length === 0) return 0;
  await tx.provisionAction.updateMany({
    where: { id: { in: abandoned.map((a) => a.id) } },
    data: { status: 'superseded', message: CANCELLED_ACTION_MESSAGE },
  });
  const orderIds = [
    ...new Set(
      abandoned.map((a) => a.revocationOrderId).filter((id): id is string => id !== null),
    ),
  ];
  if (orderIds.length > 0) {
    await tx.revocationOrder.updateMany({
      where: { id: { in: orderIds }, status: 'planned' },
      data: { status: 'open', plannedAt: null },
    });
  }
  return abandoned.length;
}

/**
 * Resolves a pending request as honoured and writes the evidence. The audit
 * event names the person who asked as its actor: the checkpoint is where their
 * decision took effect.
 */
export async function honourProvisionCancellation(
  tx: TenantClient,
  runId: string,
  phase: 'preview' | 'apply',
  counts: Record<string, number> = {},
): Promise<boolean> {
  const { count } = await tx.provisionRun.updateMany({
    where: { id: runId, cancelState: 'requested' },
    data: honouredCancellation(),
  });
  if (count === 0) return false;
  const notAttempted = await abandonProposedActions(tx, runId);
  const run = await tx.provisionRun.findUniqueOrThrow({ where: { id: runId } });
  await recordEvent(tx, {
    actorUserId: run.cancelRequestedByUserId,
    action: 'provision.run.cancelled',
    targetType: 'ProvisionRun',
    targetId: runId,
    outcome: 'success',
    sourceIp: null,
    payload: { phase, targetSystemId: run.targetSystemId, notAttempted, ...counts },
  });
  return true;
}

/**
 * Asks a provisioning run to stop.
 *
 * A `previewed` or `blocked` run is a plan waiting for a person, with nothing
 * working on it, so it is cancelled on the spot and its actions abandoned. A
 * `running` preview or an `applying` run has a worker: the request is recorded
 * and honoured at that worker's next checkpoint, which for an apply is always
 * BETWEEN two actions — never between an action's `in_flight` marker and the
 * connector's answer.
 *
 * Takes the caller's transaction so the request and its audit event commit
 * together.
 */
export async function requestCancelProvisionRun(
  tx: TenantClient,
  runId: string,
  actor: { userId: string; sourceIp: string | null },
): Promise<CancelResult> {
  const result = await requestCancellation(cancellableRuns(tx), runId, actor.userId, {
    immediate: ['previewed', 'blocked'],
    cooperative: ['running', 'applying'],
  });
  const notAttempted =
    result.outcome === 'cancelled' ? await abandonProposedActions(tx, runId) : 0;
  await recordEvent(tx, {
    actorUserId: actor.userId,
    action: 'provision.run.cancel',
    targetType: 'ProvisionRun',
    targetId: runId,
    outcome: 'success',
    sourceIp: actor.sourceIp,
    payload: { outcome: result.outcome, previousStatus: result.previousStatus, notAttempted },
  });
  return result;
}
