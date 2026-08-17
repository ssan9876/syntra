import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Check, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

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
  requiresConfirmation: boolean;
  personsEvaluated: number;
  personsUnprocessable: number;
  actions: Action[];
  exceptions: Exception[];
}

type Tab = 'person' | 'type' | 'exceptions' | 'drift';

const nameOf = (person: Person | null) =>
  person === null
    ? 'Not attributed to a person'
    : `${person.givenName ?? ''} ${person.familyName ?? ''}`.trim() || person.id;

const actionTone = (status: string): 'active' | 'warning' | 'danger' | 'neutral' => {
  if (status === 'applied') return 'active';
  if (status === 'conflict' || status === 'pending_retry') return 'warning';
  if (status === 'failed') return 'danger';
  return 'neutral';
};

const DRIFT_LABELS: Record<string, string> = {
  unmanaged_entitlement: 'A holding Provision did not grant',
  missing_grant: 'A holding Provision granted and the target no longer has',
  orphan_account: 'An account at the target Syntra holds no record of',
  account_missing_at_target: 'An account Syntra records and the target does not',
  unexpected_status: 'An account whose status at the target is not what Syntra expects',
};

export function ProvisionRunDetailPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [drift, setDrift] = useState<Drift[]>([]);
  const [tab, setTab] = useState<Tab>('person');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    void api<Run>(`/api/admin/targets/${id}/runs/${runId}`)
      .then((loaded) => {
        setRun(loaded);
        // Everything still open, ticked. A reviewer removes what they do not
        // want rather than assembling a plan the run already assembled.
        setSelected(
          new Set(
            loaded.actions.filter((a) => a.status === 'proposed').map((a) => a.id),
          ),
        );
      })
      .catch(() => setProblem('That run could not be loaded.'))
      .finally(() => setLoading(false));
    void api<{ findings: Drift[] }>(`/api/admin/targets/${id}/drift`)
      .then((body) => setDrift(body.findings))
      .catch(() => undefined);
  };
  useEffect(reload, [id, runId]);

  async function apply() {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await api<{
        status: string;
        applied: number;
        failed: number;
        skipped: number;
        pendingRetry: number;
      }>(`/api/admin/targets/${id}/runs/${runId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ only: [...selected], confirm }),
      });
      setNotice(
        `Applied ${result.applied}, failed ${result.failed}, awaiting retry ` +
          `${result.pendingRetry}. The run is now ${result.status}.`,
      );
      setConfirm(false);
      reload();
    } catch (cause) {
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
    run.requiresConfirmation ||
    run.actions.some((a) => selected.has(a.id) && a.requiresConfirmation);

  const tabs: [Tab, string][] = [
    ['person', 'By person'],
    ['type', 'By type'],
    ['exceptions', `Exceptions (${run.exceptions.length})`],
    ['drift', `Drift (${drift.length})`],
  ];

  return (
    <>
      <PageHeader
        title="Run detail"
        description={`Started ${new Date(run.startedAt).toLocaleString()} — ${
          run.personsEvaluated
        } persons evaluated.`}
      />

      <div className="space-y-6">
        {notice && <Alert tone="info">{notice}</Alert>}
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
            {!run.requiresConfirmation && (
              <p className="mt-3">
                This one cannot be confirmed away. An empty target and an
                unreachable one look identical, and a collapsed person
                population is the signature of a broken feed.
              </p>
            )}
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
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          aria-label={`Apply ${action.actionType} for ${person}`}
                          disabled={action.status !== 'proposed'}
                          checked={selected.has(action.id)}
                          onChange={(e) => toggle(action.id, e.target.checked)}
                        />
                        <code className="font-mono text-ink">
                          {action.actionType}
                        </code>
                        <Status tone={actionTone(action.status)}>
                          {action.status}
                        </Status>
                        {action.requiresConfirmation && (
                          <Status tone="warning">needs confirmation</Status>
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
                    <Status tone={actionTone(action.status)}>{action.status}</Status>
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
            description="What the target holds that Provision did not put there, and what it granted that has gone. Reported under both enforcement modes."
          >
            {drift.length === 0 ? (
              <div className="p-6">
                <Empty title="No drift outstanding">
                  Everything at the target matches what Syntra believes about it.
                </Empty>
              </div>
            ) : (
              <ul>
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
                    <Status
                      tone={finding.status === 'open' ? 'warning' : 'neutral'}
                    >
                      {finding.status}
                    </Status>
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

        {run.actions.length > 0 && (
          <Panel title="Apply">
            <div className="space-y-4 p-4">
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
                  hint="A rename, or a re-enable outside the window, is never applied without this."
                />
              )}
              <Button
                variant="primary"
                onClick={apply}
                loading={busy}
                disabled={
                  selected.size === 0 || busy || (needsConfirmation && !confirm)
                }
              >
                Apply {selected.size} action{selected.size === 1 ? '' : 's'}
              </Button>
              <p className="text-muted">
                Anything left unticked stays proposed until this run is
                superseded, so a partial apply is a pause rather than a discard.
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
