import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Panel, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';

interface SweepAction {
  id: string;
  kind: string;
  subjectPersonId: string;
  resourceType: string;
  resourceId: string;
  productId: string | null;
  status: string;
  message: string | null;
}

interface SweepDetail {
  id: string;
  status: string;
  requiresConfirmation: boolean;
  blockedReason: string | null;
  expireCount: number;
  lapseCount: number;
  reviewFlagCount: number;
  personsWithActiveContract: number;
  personsUnprocessable: number;
  actions: SweepAction[];
  exceptions: { id: string; personId: string; kind: string; message: string }[];
}

export function SweepDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<SweepDetail>(
    id === undefined ? null : `/api/admin/automate/sweeps/${id}`,
  );
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Every proposed row starts ticked. Reviewing means UNticking the ones you
    // disagree with, which is the direction that leaves an unread row proposed
    // rather than silently skipped.
    if (data)
      setTicked(
        new Set(
          data.actions.filter((a) => a.status === 'proposed').map((a) => a.id),
        ),
      );
  }, [data]);

  const apply = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/automate/sweeps/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true, only: [...ticked] }),
      });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong applying this sweep.',
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = (actionId: string) => {
    const next = new Set(ticked);
    if (next.has(actionId)) next.delete(actionId);
    else next.add(actionId);
    setTicked(next);
  };

  return (
    <>
      <PageHeader title="Sweep" />
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      {loading && (
        <Panel>
          <SkeletonRows rows={5} cols={3} />
        </Panel>
      )}
      {!loading && data && (
        <>
          {data.blockedReason && (
            // Leads with why, and the numbers behind it.
            <Alert
              tone={data.status === 'blocked' ? 'danger' : 'warning'}
              title="This sweep stopped"
            >
              {data.blockedReason}
            </Alert>
          )}

          <div className="mt-6">
            <Panel title="What it found">
              <div className="space-y-1 p-4 text-muted">
                <p>{data.expireCount} grants past their end date</p>
                <p>
                  {data.lapseCount} grants whose holder has no contract in force
                </p>
                <p>
                  {data.reviewFlagCount} grants flagged for review and left
                  alone
                </p>
                <p>
                  {data.personsWithActiveContract} people hold an active
                  contract
                </p>
              </div>
            </Panel>
          </div>

          {data.exceptions.length > 0 && (
            <div className="mt-6">
              <Panel
                title="People it could not understand"
                description="Nothing of theirs was touched. A person the system cannot understand produces no actions."
              >
                <ul className="divide-y divide-border-subtle">
                  {data.exceptions.map((exception) => (
                    <li key={exception.id} className="px-4 py-2">
                      <span className="text-ink">{exception.personId}</span>
                      <span className="text-muted"> — {exception.message}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}

          <div className="mt-6">
            <Panel
              title="Proposed removals"
              actions={
                data.status === 'previewed' ? (
                  <Button variant="primary" loading={busy} onClick={apply}>
                    Apply the ticked rows
                  </Button>
                ) : undefined
              }
            >
              <ul className="divide-y divide-border-subtle">
                {data.actions.map((action) => (
                  <li
                    key={action.id}
                    className="flex items-center gap-3 px-4 py-2"
                  >
                    <input
                      type="checkbox"
                      aria-label={`${action.resourceId} for ${action.subjectPersonId}`}
                      checked={ticked.has(action.id)}
                      disabled={data.status !== 'previewed'}
                      onChange={() => toggle(action.id)}
                    />
                    <span className="flex-1 text-ink">
                      {action.subjectPersonId} — {action.resourceId}
                    </span>
                    <span className="text-muted">{action.message}</span>
                    <Status
                      tone={action.kind === 'lapse' ? 'warning' : 'neutral'}
                    >
                      {action.kind}
                    </Status>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
