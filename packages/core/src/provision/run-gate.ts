/**
 * What an existing non-terminal run on a target means for a NEW run somebody
 * (or something) is asking for right now.
 *
 * Separate from `jobs.ts` because both the scheduled job and a person's
 * provisioning receipt ask this question, and `jobs.ts` imports the receipt
 * module -- the reverse import would be a cycle.
 *
 * `STALE_RUN_MS` is documented where the scheduler uses it, in `jobs.ts`.
 */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;

export interface ActiveRunFacts {
  id: string;
  status: string;
  requiresConfirmation: boolean;
  blockedReason?: string | null;
  startedAt: Date;
  lastProgressAt: Date | null;
}

/**
 * - `none`: nothing in the way.
 * - `wait`: a `running` preview or an `applying` run with a live worker. A new
 *   run would adopt it out from under that worker, so the caller waits.
 * - `held`: a `blocked` run that requires CONFIRMATION -- a question put to a
 *   person (a threshold tripped, or the target's first run). It is not
 *   superseded by an automated or a person-scoped request: that would take
 *   the question away from the person it was put to, and nothing about a
 *   retry answers it. It is resolved by confirming it or by cancelling it.
 * - `supersede`: safe to step over. A `previewed` plan nobody applied (its
 *   plan is recomputed anyway), a `blocked` run refused OUTRIGHT (nobody can
 *   confirm it; the new plan's guard is evaluated afresh and holds again if
 *   the cause persists), or a `running`/`applying` run whose process has
 *   shown no sign of life for `STALE_RUN_MS` (wreckage, which the new run
 *   adopts).
 */
export type ActiveRunGate = 'none' | 'wait' | 'held' | 'supersede';

export function activeRunGate(run: ActiveRunFacts | null, now: Date = new Date()): ActiveRunGate {
  if (!run) return 'none';
  if (run.status === 'running' || run.status === 'applying') {
    const aliveAt = run.lastProgressAt ?? run.startedAt;
    return now.getTime() - aliveAt.getTime() >= STALE_RUN_MS ? 'supersede' : 'wait';
  }
  if (run.status === 'blocked' && run.requiresConfirmation) return 'held';
  if (run.status === 'blocked' || run.status === 'previewed') return 'supersede';
  return 'none';
}
