/**
 * Cooperative cancellation for long-running runs: directory sync, HR person
 * imports and provisioning.
 *
 * ## Why cooperative, and why between items
 *
 * Nothing here interrupts a worker. A request is WRITTEN DOWN (`cancelState:
 * 'requested'`) and the worker reads it at checkpoints it chose itself: between
 * two records of a read, before a plan is committed, and between two items of
 * an apply. A checkpoint is always a point at which everything already done is
 * recorded and nothing is half-done, so stopping there leaves the run in an
 * honest, reviewable state:
 *
 *   - a preview stops having proposed nothing (its plan commits in one
 *     transaction, and the checkpoint is inside or before that transaction);
 *   - an apply stops with every item it already applied recorded as applied,
 *     and every item it had not reached still proposed/not attempted. It never
 *     stops in the middle of an item, and in provisioning that means never
 *     between the `in_flight` marker and the connector's answer.
 *
 * Killing the worker instead would do exactly what the apply's transaction
 * shape exists to prevent: a write that may have landed at a domain controller
 * with no record of whether it did.
 *
 * ## The states
 *
 * `cancelState` sits beside `status` rather than replacing it, because a run
 * asked to stop is still running until a checkpoint sees the request, and the
 * status must keep saying what the worker is doing.
 *
 *   null        — nobody asked.
 *   `requested` — asked; the worker has not reached a checkpoint yet.
 *   `cancelled` — honoured. The run's status is `cancelled` too.
 *   `moot`      — the run finished before any checkpoint saw the request, so it
 *                 ended normally (applied, previewed, failed...) and the
 *                 request changed nothing. Recorded, not discarded: "I pressed
 *                 cancel and it applied anyway" needs an answer on the run.
 *
 * A run that has not started doing anything — queued, or previewed and waiting
 * for somebody to apply it — has no worker to cooperate with, so a request
 * against it is honoured immediately.
 *
 * Every transition is a conditional `updateMany` keyed on the state it expects
 * to move from, so a request racing a worker's own terminal write resolves to
 * exactly one of them: PostgreSQL re-checks the WHERE clause of an UPDATE that
 * waited on a row lock against the row as the other transaction left it.
 */

export const CANCEL_STATES = ['requested', 'cancelled', 'moot'] as const;
export type CancelState = (typeof CANCEL_STATES)[number];

/**
 * No request is waiting. `moot` counts: it is a resolved request from an
 * earlier pass (an apply that finished first), and a run resumed afterwards —
 * a `partially_applied` run applied again — must be cancellable again.
 *
 * Spelled as an OR because `cancelState: { not: 'requested' }` compiles to
 * `<> 'requested'`, which is NULL, not true, for the common case of a run
 * nobody ever asked to stop.
 */
export function noActiveRequest(): { OR: { cancelState: string | null }[] } {
  // A fresh object per call: Prisma's where-input arrays are mutable types.
  return { OR: [{ cancelState: null }, { cancelState: 'moot' }] };
}

/** What a request for cancellation did. */
export type CancelOutcome =
  /** The run had not started working; it is now `cancelled`. */
  | 'cancelled'
  /** The run is working; the request is recorded for its next checkpoint. */
  | 'requested'
  /** A request was already recorded and is still waiting. Idempotent. */
  | 'already_requested';

/**
 * How many records a streaming read consumes between two checkpoints.
 *
 * A checkpoint in a read loop costs one small query. Every record would make a
 * 50,000-entry directory read issue 50,000 extra queries; never would make a
 * cancel requested ten seconds into a forty-minute read wait forty minutes.
 */
export const READ_CHECKPOINT_EVERY = 500;

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`no such run: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

/** The run has already finished (or already been cancelled). */
export class RunNotCancellableError extends Error {
  constructor(
    readonly runId: string,
    readonly status: string,
  ) {
    super(`run ${runId} is ${status}, which has nothing left to cancel`);
    this.name = 'RunNotCancellableError';
  }
}

/**
 * An apply asked of a sync or HR import run that is not in a state to apply:
 * still queued or reading, or cancelled. A cancelled run's remaining changes
 * were deliberately abandoned, and the next run re-proposes whatever is still
 * true; resurrecting them here would apply a plan somebody chose to discard.
 */
export class RunNotAppliableError extends Error {
  constructor(
    readonly runId: string,
    readonly status: string,
  ) {
    super(`run ${runId} is ${status}, which is not a state an apply may act on`);
    this.name = 'RunNotAppliableError';
  }
}

/**
 * Thrown by a PREVIEW checkpoint to unwind to the run's own error handling,
 * which records `cancelled` rather than `failed`.
 *
 * Only previews use it. A preview writes its plan in one transaction at the
 * end, so unwinding from anywhere before that transaction's commit writes no
 * plan at all — which is the whole of what a cancelled preview should leave.
 * An apply loop does not throw: it breaks out between items and then does its
 * ordinary bookkeeping for what it did apply.
 */
export class RunCancelledSignal extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} was cancelled at a checkpoint`);
    this.name = 'RunCancelledSignal';
  }
}

/**
 * The part of a Prisma run delegate this module needs.
 *
 * `SyncRun`, `PersonImportRun` and `ProvisionRun` carry the same four columns
 * under the same names, and Prisma generates three unrelated delegate types
 * for them. Narrowing each to this shape at the call site keeps one copy of
 * the state machine instead of three that drift.
 */
export interface CancellableRunDelegate {
  findUnique(args: {
    where: { id: string };
  }): Promise<{ id: string; status: string; cancelState: string | null } | null>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

export interface CancelPolicy {
  /** Statuses with no worker to cooperate with: cancelled on the spot. */
  immediate: readonly string[];
  /** Statuses with a worker that has checkpoints: a request is recorded. */
  cooperative: readonly string[];
}

export interface CancelResult {
  outcome: CancelOutcome;
  /** The status the run was in when the request landed. */
  previousStatus: string;
}

/**
 * Records a cancellation request, or honours it at once for a run that has not
 * started working. Runs inside the caller's transaction, so the caller's audit
 * event commits with it or not at all.
 *
 * Retried a bounded number of times because the run can move between the read
 * and the conditional write — a queued run starting, a preview committing its
 * plan — and the right answer depends on the state it moved TO.
 */
export async function requestCancellation(
  delegate: CancellableRunDelegate,
  runId: string,
  actorUserId: string | null,
  policy: CancelPolicy,
  now: Date = new Date(),
): Promise<CancelResult> {
  let lastStatus = 'unknown';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const run = await delegate.findUnique({ where: { id: runId } });
    if (!run) throw new RunNotFoundError(runId);
    lastStatus = run.status;

    if (run.cancelState === 'requested') {
      return { outcome: 'already_requested', previousStatus: run.status };
    }
    // An honoured request is final. A `moot` one is history, and a later
    // request against the same run is a new question.
    if (run.cancelState === 'cancelled') break;

    const where = { id: runId, status: run.status, ...noActiveRequest() };
    if (policy.immediate.includes(run.status)) {
      const { count } = await delegate.updateMany({
        where,
        data: {
          status: 'cancelled',
          cancelState: 'cancelled',
          cancelRequestedAt: now,
          cancelRequestedByUserId: actorUserId,
          cancelResolvedAt: now,
          finishedAt: now,
        },
      });
      if (count === 1) return { outcome: 'cancelled', previousStatus: run.status };
      continue;
    }
    if (policy.cooperative.includes(run.status)) {
      const { count } = await delegate.updateMany({
        where,
        data: {
          cancelState: 'requested',
          cancelRequestedAt: now,
          cancelRequestedByUserId: actorUserId,
          // A previous `moot` resolution's time, cleared: the request now
          // waiting has not been resolved.
          cancelResolvedAt: null,
        },
      });
      if (count === 1) return { outcome: 'requested', previousStatus: run.status };
      continue;
    }
    break;
  }
  throw new RunNotCancellableError(runId, lastStatus);
}

/** Whether a checkpoint should stop: the request is recorded and unresolved. */
export async function cancellationRequested(
  delegate: Pick<CancellableRunDelegate, 'findUnique'>,
  runId: string,
): Promise<boolean> {
  const run = await delegate.findUnique({ where: { id: runId } });
  return run?.cancelState === 'requested';
}

/**
 * The data that honours a request at a checkpoint. Always written through a
 * conditional update keyed on `cancelState: 'requested'`.
 */
export function honouredCancellation(now: Date = new Date()) {
  return {
    status: 'cancelled',
    cancelState: 'cancelled',
    cancelResolvedAt: now,
    finishedAt: now,
  } as const;
}

/**
 * Writes a run's ordinary terminal status, and if a request arrived that no
 * checkpoint saw, records it as `moot` in the same statement.
 *
 * Two conditional updates rather than a read and a write: the first succeeds
 * when nobody asked; if it matched nothing, a request is (or just became)
 * `requested` and the second resolves it. A request committed between the two
 * is caught by the second's WHERE, and a request that commits after both finds
 * a terminal status and is refused by `requestCancellation`.
 */
export async function finishWithCancellationCheck(
  delegate: Pick<CancellableRunDelegate, 'updateMany'>,
  runId: string,
  data: Record<string, unknown>,
  now: Date = new Date(),
): Promise<'finished' | 'moot'> {
  const plain = await delegate.updateMany({
    where: { id: runId, ...noActiveRequest() },
    data,
  });
  if (plain.count === 1) return 'finished';
  await delegate.updateMany({
    where: { id: runId, cancelState: 'requested' },
    data: { ...data, cancelState: 'moot', cancelResolvedAt: now },
  });
  return 'moot';
}
