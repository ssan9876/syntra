import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  Checkbox,
  Empty,
  Field,
  Panel,
  SkeletonRows,
  StateBadge,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageFacts, PageHeader } from './PageHeader.js';
import { ActionState, RunState } from './run-states.js';
import { SAFETY_THRESHOLDS_ANCHOR, isFirstRunHold, thresholdHints } from './threshold-hints.js';
import {
  CancelRunButton,
  CancellationStatus,
  cancelPending,
  isCancellable,
  type CancelState,
} from './RunCancellation.js';

/** Statuses with something left to cancel, as the server's policy has them. */
const CANCELLABLE = ['running', 'previewed', 'blocked', 'applying'];
/** Statuses in which a worker is active, so a cancel waits for a checkpoint. */
const WORKING = ['running', 'applying'];

interface Person {
  id: string;
  givenName: string | null;
  familyName: string | null;
}

interface Action {
  id: string;
  actionType: string;
  status: string;
  message: string | null;
  requiresConfirmation: boolean;
  sequence: number;
  attributedRuleIds: string[];
  person: Person | null;
}

interface Exception {
  id: string;
  kind: string;
  message: string;
  person: Person;
}

interface Drift {
  id: string;
  kind: string;
  status: string;
  detail: Record<string, unknown>;
}

interface Run {
  id: string;
  status: string;
  startedAt: string;
  blockedReason: string | null;
  /**
   * Why a `failed` run failed. Spec section 14's status list has no
   * `superseded`, so a run a later run stepped over is recorded `failed` with
   * `error: 'superseded by a later run'` (`run-service.ts`,
   * `adoptStaleRunsAndStart`). The runs list already reads it; this page did
   * not, and explained a superseded run as one that had been partly applied.
   */
  error: string | null;
  requiresConfirmation: boolean;
  personsEvaluated: number;
  personsUnprocessable: number;
  cancelState?: CancelState;
  cancelRequestedAt?: string | null;
  cancelResolvedAt?: string | null;
  /**
   * The adapter release the plan was computed for, and the actions it
   * refused because that release is not certified for them or the target's
   * configuration does not advertise them. Optional: an older API omits them.
   */
  adapterVersion?: string | null;
  capabilityRefusedCount?: number;
  capabilityRefusal?: string | null;
  actions: Action[];
  exceptions: Exception[];
}

type Tab = 'person' | 'type' | 'exceptions' | 'drift';

const nameOf = (person: Person | null) =>
  person === null
    ? 'Not attributed to a person'
    : `${person.givenName ?? ''} ${person.familyName ?? ''}`.trim() || person.id;

/**
 * The only two statuses `applyProvisionRun` will accept.
 *
 * `APPLIABLE_RUN_STATUSES` in `apply.ts` is `['previewed', 'blocked']`, so a
 * run that has already been partly applied cannot be applied again: a partial
 * apply ENDS the run, and whatever was left unticked is superseded by the next
 * preview and re-derived against the world as it then is. That is the right
 * design — replaying half a stale plan is how a revocation lands after the
 * grant that reversed it — but a console that offers an Apply button here
 * would be offering a 409, and the sentence under the button would be a
 * promise the engine does not keep.
 */
const APPLIABLE = ['previewed', 'blocked'];

/**
 * The server's page size for a drift read, from `provision-runs.ts`.
 *
 * `GET /targets/:id/drift` does `take: DRIFT_PAGE` with no cursor and no total,
 * so a full page is the only evidence the console gets that there was more. A
 * count that silently caps is a count that lies at exactly the moment it
 * matters most, so a full page is rendered as `500+` and said out loud.
 */
const DRIFT_PAGE = 500;

/**
 * Every field `applyProvisionRun` returns, and every one of them is rendered.
 *
 * This interface used to name five of the seven and the notice reported three
 * of those, so an apply that answered "12 applied, 3 deferred, 1 in flight"
 * was announced to the administrator as "12 applied". Extra JSON is ignored
 * rather than refused, so nothing broke and nothing said anything either.
 *
 * The two that were missing are exactly the two this branch's engine work
 * added, and both are load-bearing:
 *
 * - `deferred` — actions held back because they require an explicit
 *   confirmation and this apply was not confirmed (a rename, a re-enable
 *   outside the window, a re-create of a vanished account). On an unattended
 *   `autoApply` run this number is the whole of "the target looks healthy and
 *   is doing nothing", which is the condition Ruling P4 exists for. Computing
 *   it, returning it and then not showing it stops the fix at the API
 *   boundary.
 * - `inFlight` — the write was attempted and whether it landed is **not known
 *   here**. `resolveInFlightActions` asks the target on the next run. It is
 *   the only outcome whose truth is at the directory rather than in Syntra,
 *   so it is the one an administrator most needs to be told about, and it must
 *   never read as a plain success.
 *
 * `skipped` is not a sixth outcome: `apply.ts` computes it as
 * `count(status: 'proposed')` AFTER the deferred actions have had their
 * message written and their status left alone, so the deferred are counted
 * inside it. Rendering the two as though they were disjoint would be a
 * different false arithmetic in place of the old omission.
 */
interface ApplyResult {
  status: string;
  applied: number;
  failed: number;
  pendingRetry: number;
  inFlight: number;
  deferred: number;
  /** Refused by capability enforcement at apply time; absent from an older API. */
  refused?: number;
  skipped: number;
}

const count = (n: number, singular: string, plural: string) =>
  `${n} ${n === 1 ? singular : plural}`;

/**
 * Never `info` while anything is unresolved.
 *
 * `inFlight` outranks a failure for the heading because a failure is a known
 * outcome and an in-flight action is an unknown one, but either way this is
 * not the tone a clean apply gets.
 */
function applyTone(result: ApplyResult): 'info' | 'warning' | 'danger' {
  if (result.inFlight > 0 || result.failed > 0 || (result.refused ?? 0) > 0) return 'danger';
  if (result.pendingRetry > 0 || result.deferred > 0) return 'warning';
  return 'info';
}

function applyTitle(result: ApplyResult): string {
  if (result.inFlight > 0) {
    return `${count(result.inFlight, 'action is', 'actions are')} in flight`;
  }
  if (result.failed > 0) return `${count(result.failed, 'action', 'actions')} failed`;
  if ((result.refused ?? 0) > 0) {
    return `${count(result.refused ?? 0, 'action was', 'actions were')} refused`;
  }
  if (result.deferred > 0) {
    return `${count(result.deferred, 'action was', 'actions were')} deferred`;
  }
  if (result.pendingRetry > 0) {
    return `${count(result.pendingRetry, 'action is', 'actions are')} awaiting retry`;
  }
  // Deliberately not `${n} actions applied`, which is word-for-word the first
  // line of the list below: a heading that repeats a line of its own body reads
  // as two facts and is one.
  return result.applied === 0 ? 'Nothing was applied' : 'Applied';
}

const DRIFT_LABELS: Record<string, string> = {
  unmanaged_entitlement: 'A holding Provision did not grant',
  missing_grant: 'A holding Provision granted and the target no longer has',
  orphan_account: 'An account at the target Syntra holds no record of',
  account_missing_at_target: 'An account Syntra records and the target does not',
  unexpected_status: 'An account whose status at the target is not what Syntra expects',
};

/**
 * Which setting held this run, and where to change it.
 *
 * A threshold hold asked a question — "would create 1 of 2 accounts (50.0%),
 * above the 20% threshold" — and did not say where that 20% lives. It is on
 * the target's edit form, under Safety thresholds, and on a small directory
 * one new starter is a large share, so the answer is often "confirm this one"
 * and sometimes "that percentage is wrong for a target this size". Both are
 * offered; neither is chosen for the reader.
 */
function ThresholdHint({ targetId, blockedReason }: { targetId: string; blockedReason: string | null }) {
  const hints = thresholdHints(blockedReason);
  const firstRun = isFirstRunHold(blockedReason);
  if (hints.length === 0 && !firstRun) return null;
  return (
    <div className="mt-3 space-y-2" data-testid="threshold-hint">
      {firstRun && (
        <p>
          This is the target&rsquo;s first run, which a person always confirms
          whatever the thresholds say. No setting changes that: confirm the run
          below once the plan looks right.
        </p>
      )}
      {hints.length > 0 && (
        <>
          <p>
            {hints.length === 1 ? 'The setting that held it is' : 'The settings that held it are'}{' '}
            {hints.map((hint, index) => (
              <span key={hint.key}>
                {index > 0 ? (index === hints.length - 1 ? ' and ' : ', ') : ''}
                <strong>{hint.label}</strong>
                {hint.threshold !== null ? ` (${hint.threshold}%` : ''}
                {hint.threshold !== null && hint.share !== null ? `; this run measured ${hint.share}%)` : hint.threshold !== null ? ')' : ''}
              </span>
            ))}
            , under Safety thresholds on the target. A threshold is the largest
            share of the target a single run may change without a person
            confirming it.
          </p>
          {hints.some((hint) => hint.note) && (
            <p className="text-sm">{hints.find((hint) => hint.note)!.note}</p>
          )}
          <p>
            If this change is expected, confirm the run below. If the
            percentage is simply too low for a target this size (on a small
            directory one new account can be a large share), raise it on the{' '}
            <Link className="link" to={`/admin/targets/${targetId}#${SAFETY_THRESHOLDS_ANCHOR}`}>
              target&rsquo;s Safety thresholds
            </Link>
            ; later runs are measured against the new value.
          </p>
        </>
      )}
    </div>
  );
}

export function ProvisionRunDetailPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [drift, setDrift] = useState<Drift[] | null>(null);
  const [driftProblem, setDriftProblem] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('person');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [maintenanceClosed, setMaintenanceClosed] = useState(false);
  const [maintenanceOverrideAllowed, setMaintenanceOverrideAllowed] = useState(false);
  const [maintenanceReason, setMaintenanceReason] = useState('');
  const [outcome, setOutcome] = useState<ApplyResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // Bumped on every `reload()`, so a run or drift response for an id/runId
  // pair this screen has since moved away from - a rapid navigation between
  // runs - cannot land after the newer pair's response and overwrite it.
  const requestSeq = useRef(0);

  const reload = () => {
    const seq = ++requestSeq.current;
    void api<Run>(`/api/admin/targets/${id}/runs/${runId}`)
      .then((loaded) => {
        if (seq !== requestSeq.current) return;
        setRun(loaded);
        // Everything still open, ticked. A reviewer removes what they do not
        // want rather than assembling a plan the run already assembled.
        setSelected(
          new Set(
            loaded.actions.filter((a) => a.status === 'proposed').map((a) => a.id),
          ),
        );
      })
      .catch(() => {
        if (seq !== requestSeq.current) return;
        setProblem('That run could not be loaded.');
      })
      .finally(() => {
        if (seq !== requestSeq.current) return;
        setLoading(false);
      });
    /**
     * Open findings only, and its failure is not swallowed.
     *
     * Two separate defects lived in the three lines this replaces. The
     * rejection was discarded, so a `/drift` request that failed rendered
     * "No drift outstanding — Everything at the target matches what Syntra
     * believes about it.", which is the most reassuring sentence on the screen
     * printed on the evidence of a request that did not happen. And the read
     * was unfiltered, so the count included findings acknowledged and resolved
     * months ago — while `take: DRIFT_PAGE` and `orderBy: lastSeenAt desc`
     * meant those stale rows could crowd genuinely open ones off the end of the
     * page entirely.
     *
     * `?status=open` is a filter the route already supports
     * (`provision-runs.ts`, `GET /targets/:id/drift`), so the cap now applies
     * to the findings this tab is about.
     */
    setDriftProblem(null);
    void api<{ findings: Drift[] }>(
      `/api/admin/targets/${id}/drift?status=open`,
    )
      .then((body) => {
        if (seq !== requestSeq.current) return;
        setDrift(body.findings);
      })
      .catch(() => {
        if (seq !== requestSeq.current) return;
        setDrift(null);
        setDriftProblem(
          'The drift for this target could not be read, so this screen cannot ' +
            'say whether there is any. It is not saying there is none.',
        );
      });
  };
  useEffect(reload, [id, runId]);

  /**
   * Followed only while something is moving: a preview still reading, an
   * apply under way (this page's own POST, or anyone's), or a cancellation
   * waiting for its checkpoint. Never otherwise — `reload()` re-ticks every
   * proposed action, and polling a plan somebody is reviewing would undo
   * their selection every two seconds.
   */
  const following =
    busy ||
    (run !== null &&
      (run.status === 'running' || run.status === 'applying' || cancelPending(run)));
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
    // `reload` is recreated each render and closes over the ids only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, id, runId]);

  async function apply() {
    setBusy(true);
    setProblem(null);
    setOutcome(null);
    try {
      const result = await api<ApplyResult>(
        `/api/admin/targets/${id}/runs/${runId}/apply`,
        {
          method: 'POST',
          body: JSON.stringify({
            only: [...selected],
            confirm,
            ...(maintenanceClosed && maintenanceOverrideAllowed
              ? { maintenanceOverrideReason: maintenanceReason.trim() }
              : {}),
          }),
        },
      );
      setOutcome(result);
      setConfirm(false);
      setMaintenanceClosed(false);
      setMaintenanceReason('');
      reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'maintenance-window-closed') {
        setMaintenanceClosed(true);
        setMaintenanceOverrideAllowed(cause.problem.overrideAllowed === true);
      }
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'This run could not be applied.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge(findingId: string) {
    try {
      await api(`/api/admin/drift/${findingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'acknowledged' }),
      });
      toast({ title: 'Drift finding acknowledged' });
      reload();
    } catch {
      setProblem('That finding could not be acknowledged.');
    }
  }

  if (loading) {
    return (
      <Panel>
        <SkeletonRows rows={8} cols={3} />
      </Panel>
    );
  }
  if (!run) return <Alert tone="danger">{problem ?? 'That run is not there.'}</Alert>;

  const byPerson = new Map<string, Action[]>();
  for (const action of run.actions) {
    const key = nameOf(action.person);
    byPerson.set(key, [...(byPerson.get(key) ?? []), action]);
  }

  const toggle = (actionId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(actionId);
    else next.delete(actionId);
    setSelected(next);
  };

  // A ticked action that needs its own confirmation is enough to require the
  // box, even in a run the guard did not block.
  const needsConfirmation =
    maintenanceClosed || run.requiresConfirmation ||
    run.actions.some((a) => selected.has(a.id) && a.requiresConfirmation);

  /**
   * A blocked run the guard marked non-confirmable is refused OUTRIGHT.
   *
   * `apply.ts` throws `ProvisionRunNotConfirmableError` for
   * `status === 'blocked' && !requiresConfirmation` before it looks at
   * anything else, and `provision-runs.ts` answers 409 `run-unconfirmable` on
   * the same condition. There is no body — no `only`, no `confirm` — that
   * makes that request succeed, so an enabled Apply button here is a button
   * whose only outcome is an error, on the one screen whose job is to say what
   * the engine will do.
   */
  const unconfirmable = run.status === 'blocked' && !run.requiresConfirmation;
  const appliable = APPLIABLE.includes(run.status) && !unconfirmable;
  const superseded =
    run.status === 'failed' && (run.error ?? '').startsWith('superseded');

  const tabs: [Tab, string][] = [
    ['person', 'By person'],
    ['type', 'By type'],
    ['exceptions', `Exceptions (${run.exceptions.length})`],
    [
      'drift',
      // Never `(0)` on a read that failed: that is the same false reassurance
      // in a smaller place.
      drift === null
        ? 'Drift (unknown)'
        : `Drift (${drift.length >= DRIFT_PAGE ? `${DRIFT_PAGE}+` : drift.length})`,
    ],
  ];

  return (
    <>
      <PageHeader
        title="Run detail"
        status={<RunState status={superseded ? 'superseded' : run.status} />}
        actions={
          isCancellable(run, CANCELLABLE) ? (
            <CancelRunButton
              path={`/api/admin/targets/${id}/runs/${run.id}/cancel`}
              run={run}
              working={WORKING}
              noun="provisioning run"
              onChanged={reload}
            />
          ) : undefined
        }
      />

      {/* Both were in the header's sentence, and both are figures. A run's
          start and the size of the population it looked at are the two things
          somebody checks before reading a single proposed change. */}
      <PageFacts
        facts={[
          { label: 'Started', value: new Date(run.startedAt).toLocaleString() },
          { label: 'Persons evaluated', value: run.personsEvaluated },
        ]}
      />

      <div className="space-y-6">
        <CancellationStatus run={run} noun="provisioning run" />
        {outcome && (
          <Alert tone={applyTone(outcome)} title={applyTitle(outcome)}>
            {/* Every state, every time, including the zeros. A count that is
                only printed when it is non-zero is a count a reader cannot
                tell from a count nobody computed — and it was the silent
                omission of two of these that this alert was rewritten for. */}
            <p>The run is now {outcome.status}.</p>
            <ul className="mt-2 list-disc pl-5">
              <li>{count(outcome.applied, 'action', 'actions')} applied</li>
              <li>{count(outcome.failed, 'action', 'actions')} failed</li>
              <li>
                {count(outcome.pendingRetry, 'action', 'actions')} awaiting
                retry — a retryable failure, which the next run for this target
                picks up
              </li>
              <li>
                {count(outcome.inFlight, 'action', 'actions')} in flight — the
                write was attempted and whether it landed is at the target, not
                here. The next run asks the directory and resolves it.
              </li>
              <li>
                {count(outcome.deferred, 'action', 'actions')} deferred — they
                require an explicit confirmation and this apply was not
                confirmed
              </li>
              {outcome.refused !== undefined && (
                <li>
                  {count(outcome.refused, 'action', 'actions')} refused — the
                  adapter release is not certified for it, or the target no
                  longer advertises it; never attempted
                </li>
              )}
            </ul>
            {outcome.skipped > 0 && (
              // Stated as the total it is. `apply.ts` counts every action left
              // `proposed`, and a deferred action is left `proposed`, so the
              // deferred are inside this number rather than beside it.
              <p className="mt-2">
                {count(outcome.skipped, 'action', 'actions')} were left
                unapplied altogether, the deferred among them. Applying part of
                a run ends it: the next run works out afresh what is still
                needed.
              </p>
            )}
          </Alert>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}

        {run.status === 'blocked' && (
          <Alert tone="warning" title="This run is blocked">
            {/* A blocked run leads with why, and with the numbers behind it. */}
            <ul className="list-disc pl-5">
              {(run.blockedReason ?? 'no reason was recorded')
                .split('; ')
                .map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
            </ul>
            {run.requiresConfirmation && (
              <ThresholdHint targetId={id ?? ''} blockedReason={run.blockedReason} />
            )}
            {!run.requiresConfirmation && (
              /*
               * No enumeration. `guard.ts` returns
               * `requiresConfirmation: false` from three places covering five
               * distinct classes of refusal — a threshold or a count that is
               * not a number, no persons holding an active contract at all, a
               * collapsed person population, a target that returned no
               * accounts, and any axis whose denominator is missing — and a
               * screen that names two of them is wrong about the other three
               * and goes on being wrong as the guard grows. The principle is
               * stable; the list is not, and the reasons above are the run's
               * own.
               */
              <p className="mt-3">
                This one cannot be confirmed away. A tick means &ldquo;I have
                read the numbers and want this anyway&rdquo;, and the guard
                refused this run because it could not compute a number for
                anybody to have read. The reasons above say which check
                refused it.
              </p>
            )}
          </Alert>
        )}

        {(run.capabilityRefusedCount ?? 0) > 0 && (
          <Alert
            tone="danger"
            title={`${run.capabilityRefusedCount} action${
              run.capabilityRefusedCount === 1 ? '' : 's'
            } refused by capability enforcement`}
          >
            {/* Shown, never dropped: a refused action is what the plan would
                have done, and the reason is what somebody has to fix. */}
            <ul className="list-disc pl-5">
              {(run.capabilityRefusal ?? '').split('; ').map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p className="mt-3">
              Refused actions are never attempted. The rest of the plan is
              unaffected.
              {run.adapterVersion ? ` Planned for adapter ${run.adapterVersion}.` : ''}
            </p>
          </Alert>
        )}

        {run.exceptions.length > 0 && (
          <Alert
            tone="danger"
            title={`${run.exceptions.length} person${
              run.exceptions.length === 1 ? '' : 's'
            } could not be processed`}
          >
            {/* An exception is not a warning to be scrolled past: every person
                on that list is a person whose access is frozen until somebody
                fixes something. */}
            They were excluded from this plan entirely and their existing access
            was not touched. Read them on the Exceptions tab.
          </Alert>
        )}

        <nav className="flex flex-wrap gap-1 border-b border-border-subtle">
          {tabs.map(([name, label]) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              aria-current={tab === name ? 'page' : undefined}
              className={[
                'rounded-t-control px-3 py-2 font-medium',
                tab === name
                  ? 'border-b-2 border-primary text-ink'
                  : 'text-muted hover:text-ink',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'person' &&
          (run.actions.length === 0 ? (
            <Panel>
              <div className="p-6">
                {/* Convergence, and it has to say so. An empty plan and a plan
                    that failed to compute look identical otherwise. */}
                <Empty title="This run proposes nothing">
                  Every person already matches what the rules and the account
                  profile say they should have.
                </Empty>
              </div>
            </Panel>
          ) : (
            <div className="space-y-4">
              {[...byPerson].map(([person, actions]) => (
                <Panel key={person} title={person}>
                  <ul>
                    {actions.map((action) => (
                      <li
                        key={action.id}
                        className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-0"
                      >
                        <Checkbox
                          label={`Apply ${action.actionType} for ${person}`}
                          disabled={action.status !== 'proposed'}
                          checked={selected.has(action.id)}
                          onChange={(on) => toggle(action.id, on)}
                        />
                        <code className="font-mono text-ink">
                          {action.actionType}
                        </code>
                        <ActionState status={action.status} />
                        {action.requiresConfirmation && (
                          <StateBadge state="attention">Needs confirmation</StateBadge>
                        )}
                        {action.message && (
                          <span className="text-muted">{action.message}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </Panel>
              ))}
            </div>
          ))}

        {tab === 'type' && (
          <Panel>
            {run.actions.length === 0 ? (
              <div className="p-6">
                <Empty title="This run proposes nothing">
                  Nothing to group.
                </Empty>
              </div>
            ) : (
              <ul>
                {run.actions.map((action) => (
                  <li
                    key={action.id}
                    className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-0"
                  >
                    <code className="font-mono text-ink">{action.actionType}</code>
                    <span className="text-ink">{nameOf(action.person)}</span>
                    <ActionState status={action.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {tab === 'exceptions' && (
          <Panel>
            {run.exceptions.length === 0 ? (
              <div className="p-6">
                <Empty title="Everybody was processed">
                  No person was excluded from this plan.
                </Empty>
              </div>
            ) : (
              <ul>
                {run.exceptions.map((exception) => (
                  <li
                    key={exception.id}
                    className="border-b border-border-subtle px-4 py-2.5 last:border-0"
                  >
                    <p className="font-medium text-ink">
                      {nameOf(exception.person)}
                    </p>
                    <p className="text-muted">
                      <code className="font-mono">{exception.kind}</code> —{' '}
                      {exception.message}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {tab === 'drift' && (
          <Panel
            title="Drift"
          >
            {drift === null ? (
              <div className="p-4">
                <Alert tone="danger" title="Drift could not be read">
                  {driftProblem}
                </Alert>
              </div>
            ) : drift.length === 0 ? (
              <div className="p-6">
                <Empty title="No drift outstanding">
                  Everything at the target matches what Syntra believes about it.
                </Empty>
              </div>
            ) : (
              <ul>
                {drift.length >= DRIFT_PAGE && (
                  <li className="border-b border-border-subtle p-4">
                    <Alert tone="warning" title="This list is not all of it">
                      The server returns at most {DRIFT_PAGE} findings in one
                      read, and it returned {DRIFT_PAGE}. There are more open
                      findings than are shown here.
                    </Alert>
                  </li>
                )}
                {drift.map((finding) => (
                  <li
                    key={finding.id}
                    className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-0"
                  >
                    <span className="text-ink">
                      {DRIFT_LABELS[finding.kind] ?? finding.kind}
                    </span>
                    <span className="text-muted">
                      {String(finding.detail.reason ?? '')}
                    </span>
                    {finding.status === 'open' ? (
                      <StateBadge state="attention">Open</StateBadge>
                    ) : (
                      <StateBadge state="inactive">
                        {finding.status.charAt(0).toUpperCase() + finding.status.slice(1)}
                      </StateBadge>
                    )}
                    {finding.status === 'open' && (
                      <Button size="sm" onClick={() => acknowledge(finding.id)}>
                        Acknowledge
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {run.actions.length > 0 && !appliable && (
          <Panel
            title={
              unconfirmable ? 'This run cannot be applied' : 'Nothing further to apply'
            }
          >
            <p className="p-4 text-muted">
              {unconfirmable ? (
                <>
                  The guard refused it for a reason no confirmation answers, so
                  there is no Apply here: the server refuses the request
                  outright, whatever is ticked. Put right what the reasons above
                  name; the next run supersedes this one and works the plan out
                  afresh, and it does not wait for a staleness window to do it.
                </>
              ) : superseded ? (
                <>
                  A later run superseded this one, and its still-proposed
                  actions were marked superseded rather than applied. Two
                  overlapping plans against one target can interleave a
                  revocation from the older behind a grant from the newer,
                  producing a state neither plan described. Whatever is still
                  needed is in the newer run.
                </>
              ) : (
                <>
                  This run is{' '}
                  <strong className="font-semibold">{run.status}</strong>.
                  Applying part of a run ends it: anything left unticked was not
                  written, and the next run works out afresh what is still
                  needed rather than replaying a plan that has gone stale.
                </>
              )}
            </p>
          </Panel>
        )}

        {run.actions.length > 0 && appliable && (
          <Panel title="Apply">
            <div className="space-y-4 p-4">
              {maintenanceClosed && (
                <Alert tone={maintenanceOverrideAllowed ? 'warning' : 'danger'} title="Outside the target maintenance window">
                  {maintenanceOverrideAllowed
                    ? 'Only the selected leaver-removal actions are eligible for an urgent exception. Confirm the apply and record the operational reason.'
                    : 'This selection includes actions that cannot bypass the maintenance window. Wait for the window or select only revocations, disables, archives, and Syntra-login deactivations.'}
                </Alert>
              )}
              {maintenanceClosed && maintenanceOverrideAllowed && (
                <Field
                  label="Urgent leaver exception reason"
                  value={maintenanceReason}
                  onChange={setMaintenanceReason}
                  maxLength={500}
                  required
                />
              )}
              {needsConfirmation && run.requiresConfirmation && (
                <Check
                  checked={confirm}
                  onChange={setConfirm}
                  label="I have read the numbers above and want to apply this run anyway"
                />
              )}
              {needsConfirmation && !run.requiresConfirmation && (
                <Check
                  checked={confirm}
                  onChange={setConfirm}
                  label="I have read what needs confirmation and want to apply it"
                />
              )}
              <Button
                variant="primary"
                onClick={apply}
                loading={busy}
                disabled={
                  selected.size === 0 || busy || (needsConfirmation && !confirm) ||
                  (maintenanceClosed && (!maintenanceOverrideAllowed || maintenanceReason.trim().length < 10))
                }
              >
                Apply {selected.size} action{selected.size === 1 ? '' : 's'}
              </Button>
              <p className="text-muted">
                Applying part of a run ends it. Anything left unticked is not
                written, and the next run decides again whether it is still
                needed — this is a plan, not a queue to work through.
              </p>
            </div>
          </Panel>
        )}

        <Link
          to={`/admin/targets/${id}/runs`}
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to runs
        </Link>
      </div>
    </>
  );
}
