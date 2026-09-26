import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Empty,
  Panel,
  RefreshStatus,
  SkeletonRows,
  useToast,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';
import { when } from '../automate/status.js';
import { RunState } from './run-states.js';

interface SweepRow {
  id: string;
  status: string;
  startedAt: string;
  expireCount: number;
  lapseCount: number;
  requiresConfirmation: boolean;
  blockedReason: string | null;
}

export function SweepsTab() {
  const { data, error, loading, updatedAt, reload } = useApiResource<{
    sweeps: SweepRow[];
  }>('/api/admin/automate/sweeps');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();

  const runNow = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api('/api/admin/automate/sweeps', { method: 'POST' });
      toast({ title: 'Sweep preview started' });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* The action sits with the table it acts on. One header above
          several tabs would need a word saying which tab its button
          applied to. */}
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        {data && <RefreshStatus updatedAt={updatedAt} onRefresh={reload} refreshing={loading} />}
        {/* On an empty list the empty state carries this button instead. */}
        {(!data || (data.sweeps ?? []).length > 0) && (
          <Button loading={busy} onClick={runNow}>
            Run a preview now
          </Button>
        )}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      <Panel>
        {!data && !error && <SkeletonRows rows={4} cols={4} />}
        {data && (data.sweeps ?? []).length === 0 && (
          <div className="p-6">
            <Empty
              title="No sweeps yet"
              action={
                <Button variant="primary" loading={busy} onClick={runNow}>
                  Run a preview now
                </Button>
              }
            />
          </div>
        )}
        {data && (data.sweeps ?? []).length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {(data.sweeps ?? []).map((sweep) => (
              <li
                key={sweep.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <Link
                    to={`/admin/automate/sweeps/${sweep.id}`}
                    className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                  >
                    {when(sweep.startedAt)}
                  </Link>
                  <p className="text-sm text-muted">
                    {sweep.expireCount} expiring, {sweep.lapseCount} lapsing
                  </p>
                  {sweep.blockedReason && (
                    <p className="text-sm text-danger">{sweep.blockedReason}</p>
                  )}
                </div>
                <RunState status={sweep.status} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
