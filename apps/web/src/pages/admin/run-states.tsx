import { StateBadge, type State } from '@syntra/ui';

/**
 * One reading of a run's status, for every kind of run the console lists.
 *
 * Directory syncs, person imports, provisioning runs, sweeps and snapshots
 * each grew their own status→tone table, and they disagreed: a blocked
 * provisioning run was amber on its list and red on the sync list beside it,
 * `running` was grey here and amber there, and `previewed` was a primary
 * badge that read like a button. A reader scanning "what ran last night"
 * across two tabs could not learn what a colour meant because it did not
 * mean the same thing twice.
 *
 * The mapping follows `StateBadge`'s seven states, and the word stays the
 * domain's own — "Previewed", not "Pending verification" — because the
 * operator is reading a run, not a legend.
 *
 * - failed / blocked → `blocked`: a person has to act before anything moves.
 * - running / applying / building → `running`: Syntra is doing it now.
 * - queued / previewed / awaiting approval → `pending`: waiting on a worker
 *   to pick it up, or on a reviewer to read the plan.
 * - partially applied / warnings → `attention`.
 * - applied / complete / succeeded → `healthy`.
 * - cancelled / superseded → `inactive`: a deliberate outcome, not a fault,
 *   so red keeps meaning "look at this".
 */
export const RUN_STATE: Record<string, State> = {
  queued: 'pending',
  running: 'running',
  applying: 'running',
  building: 'running',
  computing: 'running',
  previewed: 'pending',
  awaiting_approval: 'pending',
  blocked: 'blocked',
  failed: 'blocked',
  partially_applied: 'attention',
  applied: 'healthy',
  complete: 'healthy',
  completed: 'healthy',
  succeeded: 'healthy',
  cancelled: 'inactive',
  superseded: 'inactive',
};

export const RUN_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  applying: 'Applying',
  building: 'Building',
  computing: 'Computing',
  previewed: 'Previewed',
  awaiting_approval: 'Awaiting approval',
  blocked: 'Blocked',
  failed: 'Failed',
  partially_applied: 'Partially applied',
  applied: 'Applied',
  complete: 'Complete',
  completed: 'Completed',
  succeeded: 'Succeeded',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};

/**
 * One action or change inside a run — a proposed write, not the run itself.
 * `proposed` is the plan waiting on its reviewer; `in_flight`,
 * `pending_retry`, `dispatched` and `confirmed` wait on the target or on a
 * later read-back to verify them.
 */
export const ACTION_STATE: Record<string, State> = {
  proposed: 'pending',
  // Sent, and waiting on the owning subsystem to say it landed.
  dispatched: 'pending',
  confirmed: 'pending',
  in_flight: 'pending',
  pending_retry: 'pending',
  applied: 'healthy',
  conflict: 'attention',
  failed: 'blocked',
  refused: 'blocked',
  skipped: 'inactive',
  superseded: 'inactive',
};

export const ACTION_LABEL: Record<string, string> = {
  proposed: 'Proposed',
  dispatched: 'Dispatched',
  confirmed: 'Confirmed',
  in_flight: 'In flight',
  pending_retry: 'Awaiting retry',
  applied: 'Applied',
  conflict: 'Conflict',
  failed: 'Failed',
  refused: 'Refused',
  skipped: 'Skipped',
  superseded: 'Superseded',
};

/** An unknown status is shown as itself, readable, and never dressed as healthy. */
const humanise = (status: string) => {
  const words = status.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const runState = (status: string): State => RUN_STATE[status] ?? 'setup';
export const runLabel = (status: string): string => RUN_LABEL[status] ?? humanise(status);

export function RunState({ status }: { status: string }) {
  return <StateBadge state={runState(status)}>{runLabel(status)}</StateBadge>;
}

export function ActionState({ status }: { status: string }) {
  return (
    <StateBadge state={ACTION_STATE[status] ?? 'setup'}>
      {ACTION_LABEL[status] ?? humanise(status)}
    </StateBadge>
  );
}
