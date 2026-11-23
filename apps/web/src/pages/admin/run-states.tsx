import { StateBadge, type State } from '@syntra/ui';
import { consoleEn, useConsoleT, type ConsoleKey, type ConsoleT } from '../../i18n/console/index.js';

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

/** An unknown status is shown as itself, readable, and never dressed as healthy. */
const humanise = (status: string) => {
  const words = status.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The label for a status, from the catalog under `prefix`, or the status itself. */
function label(t: ConsoleT, prefix: 'runState' | 'actionState', status: string): string {
  const key = `${prefix}.${status}`;
  return key in consoleEn ? t(key as ConsoleKey) : humanise(status);
}

export const runState = (status: string): State => RUN_STATE[status] ?? 'setup';
export const runLabel = (t: ConsoleT, status: string): string => label(t, 'runState', status);

export function RunState({ status }: { status: string }) {
  const t = useConsoleT();
  return <StateBadge state={runState(status)}>{runLabel(t, status)}</StateBadge>;
}

export function ActionState({ status }: { status: string }) {
  const t = useConsoleT();
  return (
    <StateBadge state={ACTION_STATE[status] ?? 'setup'}>
      {label(t, 'actionState', status)}
    </StateBadge>
  );
}