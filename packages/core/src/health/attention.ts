import type { TenantClient } from '@syntra/db';

/**
 * Work that is waiting for a PERSON, gathered for the console-wide banner and
 * the Activity → Attention tab.
 *
 * Different from `listIncidents`, which is about things that have stopped
 * working. Nothing here is broken: a run the guard held for review, an
 * onboarding waiting on somebody to confirm what the target shows, a
 * privileged change waiting for a second administrator. Each of those is a
 * decision that belongs to someone, and each was visible only on a screen
 * somebody had to already know to open — a run held at 50% for "would create
 * 1 of 2 accounts" sat unseen, and every receipt on that target was refused
 * behind it.
 *
 * Every section is read only for a caller who may read the thing it lists;
 * `allowed` is decided by the route from the caller's own permissions, and a
 * section the caller may not read is left out entirely rather than counted.
 */

export interface AttentionRunItem {
  runId: string;
  targetSystemId: string;
  targetName: string;
  /** `blocked`: the guard held it. `previewed`: a plan is waiting to be applied. */
  status: 'previewed' | 'blocked';
  /** False on a `blocked` run the guard refused outright: fix the cause, then run again. */
  requiresConfirmation: boolean;
  blockedReason: string | null;
  /** How many changes the plan holds, from the run's own counters. */
  plannedChanges: number;
  /** Those changes as a phrase — "would create 1 account" — or null when there are none. */
  planned: string | null;
  /** One sentence, built from the run's own counters and reason. */
  summary: string;
  startedAt: Date;
  href: string;
}

export interface AttentionLifecycleItem {
  operationId: string;
  kind: string;
  state: 'failed' | 'awaiting_verification';
  message: string | null;
  updatedAt: Date;
  href: string;
}

export interface AttentionChangeItem {
  id: string;
  summary: string;
  changeClass: string;
  requestedAt: Date;
  expiresAt: Date;
  href: string;
}

export interface AttentionSummary {
  total: number;
  provisionRuns: { count: number; items: AttentionRunItem[] } | null;
  lifecycle: { failed: number; awaitingVerification: number; items: AttentionLifecycleItem[] } | null;
  changeRequests: { count: number; items: AttentionChangeItem[] } | null;
}

/** Rows returned per section. The counts are always the whole number. */
export const ATTENTION_ITEM_LIMIT = 10;

const TERMINAL_OPERATION = ['completed', 'cancelled', 'rejected'];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The run's planned changes, named from its own counters, in one phrase. */
function plannedPhrase(run: RunCounters): string {
  const parts: string[] = [];
  const add = (n: number, verb: string, one: string, many: string) => {
    if (n > 0) parts.push(`${verb} ${plural(n, one, many)}`);
  };
  add(run.createAccountCount, 'create', 'account', 'accounts');
  add(run.updateAccountCount, 'update', 'account', 'accounts');
  add(run.enableAccountCount, 'enable', 'account', 'accounts');
  add(run.disableAccountCount, 'disable', 'account', 'accounts');
  add(run.archiveAccountCount, 'archive', 'account', 'accounts');
  add(run.renameAccountCount, 'rename', 'account', 'accounts');
  add(run.grantEntitlementCount, 'grant', 'entitlement', 'entitlements');
  add(run.revokeEntitlementCount, 'revoke', 'entitlement', 'entitlements');
  add(run.deactivateSyntraUserCount, 'deactivate', 'Syntra login', 'Syntra logins');
  add(run.reactivateSyntraUserCount, 'reactivate', 'Syntra login', 'Syntra logins');
  return parts.join(', ');
}

interface RunCounters {
  createAccountCount: number;
  updateAccountCount: number;
  enableAccountCount: number;
  disableAccountCount: number;
  archiveAccountCount: number;
  renameAccountCount: number;
  grantEntitlementCount: number;
  revokeEntitlementCount: number;
  deactivateSyntraUserCount: number;
  reactivateSyntraUserCount: number;
}

function plannedCount(run: RunCounters): number {
  return (
    run.createAccountCount + run.updateAccountCount + run.enableAccountCount +
    run.disableAccountCount + run.archiveAccountCount + run.renameAccountCount +
    run.grantEntitlementCount + run.revokeEntitlementCount +
    run.deactivateSyntraUserCount + run.reactivateSyntraUserCount
  );
}

/** What a reader needs to decide whether to open the run, in one sentence. */
export function runAttentionSummary(run: RunCounters & {
  status: string;
  requiresConfirmation: boolean;
  blockedReason: string | null;
}): string {
  const planned = plannedPhrase(run);
  if (run.status === 'blocked') {
    const reason = run.blockedReason?.split('; ')[0] ?? 'no reason was recorded';
    return run.requiresConfirmation
      ? `Held for confirmation: ${reason}`
      : `Refused by the safety guard: ${reason}`;
  }
  return planned ? `Waiting to be applied: would ${planned}` : 'Waiting to be applied: no changes planned';
}

export async function readAttentionSummary(
  tx: TenantClient,
  allowed: { provision: boolean; changeRequests: boolean },
  now: Date = new Date(),
): Promise<AttentionSummary> {
  let provisionRuns: AttentionSummary['provisionRuns'] = null;
  let lifecycle: AttentionSummary['lifecycle'] = null;
  let changeRequests: AttentionSummary['changeRequests'] = null;

  if (allowed.provision) {
    // `previewed` and `blocked` are exactly the statuses the scheduled job
    // and the receipt worker treat as "awaiting review" — the ones that stop
    // later runs on the same target.
    const where = { status: { in: ['previewed', 'blocked'] } };
    const [count, runs] = await Promise.all([
      tx.provisionRun.count({ where }),
      tx.provisionRun.findMany({
        where,
        orderBy: { startedAt: 'asc' },
        take: ATTENTION_ITEM_LIMIT,
        include: { target: { select: { id: true, name: true } } },
      }),
    ]);
    provisionRuns = {
      count,
      items: runs.map((run) => ({
        runId: run.id,
        targetSystemId: run.targetSystemId,
        targetName: run.target.name,
        status: run.status as 'previewed' | 'blocked',
        requiresConfirmation: run.requiresConfirmation,
        blockedReason: run.blockedReason,
        plannedChanges: plannedCount(run),
        planned: plannedPhrase(run) ? `would ${plannedPhrase(run)}` : null,
        summary: runAttentionSummary(run),
        startedAt: run.startedAt,
        href: `/admin/targets/${run.targetSystemId}/runs/${run.id}`,
      })),
    };

    // Lifecycle work is read with `provision.read` too: it is what the
    // lifecycle-operations routes are gated on.
    const open = { status: { notIn: TERMINAL_OPERATION } };
    const failedWhere = { status: 'failed' };
    const verifyingWhere = {
      ...open,
      steps: { some: { key: 'targets', status: 'running', responseCategory: 'read_back_incomplete' } },
    };
    const [failed, awaitingVerification, failedRows, verifyingRows] = await Promise.all([
      tx.lifecycleOperation.count({ where: failedWhere }),
      tx.lifecycleOperation.count({ where: verifyingWhere }),
      tx.lifecycleOperation.findMany({
        where: failedWhere,
        orderBy: { updatedAt: 'desc' },
        take: ATTENTION_ITEM_LIMIT,
        include: { steps: { where: { status: 'failed' }, select: { message: true }, take: 1 } },
      }),
      tx.lifecycleOperation.findMany({
        where: verifyingWhere,
        orderBy: { updatedAt: 'desc' },
        take: ATTENTION_ITEM_LIMIT,
        include: { steps: { where: { key: 'targets' }, select: { message: true }, take: 1 } },
      }),
    ]);
    const items: AttentionLifecycleItem[] = [
      ...failedRows.map((operation) => ({
        operationId: operation.id,
        kind: operation.kind,
        state: 'failed' as const,
        message: operation.steps[0]?.message ?? null,
        updatedAt: operation.updatedAt,
        href: `/admin/lifecycle-operations/${operation.id}`,
      })),
      ...verifyingRows.map((operation) => ({
        operationId: operation.id,
        kind: operation.kind,
        state: 'awaiting_verification' as const,
        message: operation.steps[0]?.message ?? null,
        updatedAt: operation.updatedAt,
        href: `/admin/lifecycle-operations/${operation.id}`,
      })),
    ].slice(0, ATTENTION_ITEM_LIMIT);
    lifecycle = { failed, awaitingVerification, items };
  }

  if (allowed.changeRequests) {
    // Pending and not yet past its window. An expired request is closed by
    // `expirePrivilegedChanges` the next time the queue is read; counting it
    // here would ask somebody to decide something that can no longer be.
    const where = { status: 'pending', expiresAt: { gt: now } };
    const [count, rows] = await Promise.all([
      tx.privilegedChangeRequest.count({ where }),
      tx.privilegedChangeRequest.findMany({
        where,
        orderBy: { requestedAt: 'asc' },
        take: ATTENTION_ITEM_LIMIT,
        select: { id: true, summary: true, changeClass: true, requestedAt: true, expiresAt: true },
      }),
    ]);
    changeRequests = {
      count,
      items: rows.map((row) => ({ ...row, href: '/admin/settings?tab=change-control' })),
    };
  }

  const total =
    (provisionRuns?.count ?? 0) +
    (lifecycle ? lifecycle.failed + lifecycle.awaitingVerification : 0) +
    (changeRequests?.count ?? 0);
  return { total, provisionRuns, lifecycle, changeRequests };
}
