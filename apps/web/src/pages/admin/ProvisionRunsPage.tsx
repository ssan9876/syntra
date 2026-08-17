import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

interface Run {
  id: string;
  status: string;
  startedAt: string;
  personsEvaluated: number;
  personsUnprocessable: number;
  blockedReason: string | null;
  error: string | null;
}

/**
 * Spec section 14's status list has no `superseded`, so a run that a later run
 * stepped over is recorded `failed` with an explanatory `error` — which is a
 * defensible choice for the data and a bad one for the screen, because it puts
 * routine supersedes and genuine failures in the same red bucket and trains
 * people to ignore red.
 */
const displayStatus = (run: Run) =>
  run.status === 'failed' && (run.error ?? '').startsWith('superseded')
    ? 'superseded'
    : run.status;

const tone = (status: string): 'active' | 'warning' | 'danger' | 'neutral' => {
  if (status === 'applied') return 'active';
  if (status === 'blocked') return 'warning';
  if (status === 'failed') return 'danger';
  return 'neutral';
};

/** How long to keep looking for a run that has been queued but not yet started. */
const POLL_MS = 2000;
const POLL_LIMIT = 10;

export function ProvisionRunsPage() {
  const { id } = useParams<{ id: string }>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const seen = useRef(0);

  const reload = () => {
    void api<{ runs: Run[] }>(`/api/admin/targets/${id}/runs`)
      .then((body) => {
        setRuns(body.runs);
        if (body.runs.length > seen.current) {
          seen.current = body.runs.length;
          setWaiting(0);
        }
      })
      .catch(() => setProblem('The runs for this target could not be loaded.'))
      .finally(() => setLoading(false));
  };
  useEffect(reload, [id]);

  /**
   * A run is enqueued, not performed in the request — a full target read
   * outlasts a proxy timeout — so the row appears when the worker picks the
   * job up rather than when the button is released. Polled for a bounded
   * while, then left to the Refresh button: a page that spins forever is a
   * page that lies about what it knows.
   */
  useEffect(() => {
    if (waiting === 0) return;
    const timer = setTimeout(() => {
      reload();
      setWaiting((n) => (n >= POLL_LIMIT ? 0 : n + 1));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, id]);

  async function onRun() {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      await api(`/api/admin/targets/${id}/runs`, { method: 'POST' });
      seen.current = runs.length;
      setNotice(
        'A run has been queued. It appears below once the worker picks it up.',
      );
      setWaiting(1);
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'The run could not be started.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Runs"
        description="What each run proposed, what was applied, and what it refused to do."
        actions={
          <>
            <Button onClick={reload} disabled={busy}>
              Refresh
            </Button>
            <Button variant="primary" onClick={onRun} loading={busy}>
              Run now
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        {notice && <Alert tone="info">{notice}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}

        <Panel>
          {loading && <SkeletonRows rows={4} cols={4} />}

          {!loading && runs.length === 0 && (
            <div className="p-6">
              <Empty title="No runs yet">
                A run evaluates every person against this target&apos;s rules and
                proposes what it would change. Nothing is written until the plan
                is reviewed.
              </Empty>
            </div>
          )}

          {!loading && runs.length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Started
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Persons
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Could not be processed
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const status = displayStatus(run);
                  return (
                    <tr
                      key={run.id}
                      className="border-b border-border-subtle last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/admin/targets/${id}/runs/${run.id}`}
                          className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                        >
                          {new Date(run.startedAt).toLocaleString()}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <span title={run.blockedReason ?? run.error ?? undefined}>
                          <Status tone={tone(status)}>{status}</Status>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-ink">
                        {run.personsEvaluated}
                      </td>
                      <td
                        className={`px-4 py-2.5 tabular-nums ${
                          run.personsUnprocessable > 0
                            ? 'font-semibold text-danger'
                            : 'text-muted'
                        }`}
                      >
                        {run.personsUnprocessable}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Link
          to={`/admin/targets/${id}`}
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to the target
        </Link>
      </div>
    </>
  );
}
