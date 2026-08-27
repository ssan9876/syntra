import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';

interface SnapshotRow {
  id: string;
  kind: string;
  status: string;
  asOf: string;
  holdingCount: number;
  unattributableCount: number;
  coverageGapCount: number;
  error: string | null;
}

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';
const TONE: Record<string, Tone> = { building: 'primary', complete: 'active', failed: 'danger' };

export function GovernSnapshotsTab() {
  const { data, error, loading, reload } = useApiResource<{ snapshots: SnapshotRow[] }>(
    '/api/admin/govern/snapshots',
  );
  const [actionError, setActionError] = useState<string | null>(null);
  // Narrowed once: a 200 without its collection must render an empty table,
  // not blank the console.
  const snapshots = data?.snapshots ?? [];

  return (
    <>
      {/* The action sits with the table it acts on. One header above
          several tabs would need a word saying which tab its button
          applied to. */}
      <div className="mb-4 flex justify-end">
        <Button
            onClick={() => {
              void api('/api/admin/govern/snapshots', {
                method: 'POST',
                body: JSON.stringify({ kind: 'manual' }),
              })
                .then(() => {
                  setActionError(null);
                  reload();
                })
                .catch((cause: unknown) =>
                  setActionError(
                    cause instanceof ApiError
                      ? (cause.problem.detail ?? cause.problem.title)
                      : 'Could not build a snapshot.',
                  ),
                );
            }}
          >
            Build a snapshot now
          </Button>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      <Panel>
        {loading && <SkeletonRows rows={6} cols={5} />}
        {!loading && (data?.snapshots.length ?? 0) === 0 && (
          <div className="p-6">
            <Empty title="No snapshots yet">
              Build one and the inventory, the coverage register and the standing findings
              appear on their own.
            </Empty>
          </div>
        )}
        {!loading && snapshots.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>As of</th>
                <th>Status</th>
                <th>Holdings</th>
                <th>Nobody can explain</th>
                <th>Coverage gaps</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link className="text-primary" to={`/admin/govern/snapshots/${s.id}`}>
                      {new Date(s.asOf).toLocaleString()}
                    </Link>
                  </td>
                  <td>
                    <Status tone={TONE[s.status] ?? 'neutral'}>{s.status}</Status>
                  </td>
                  <td>
                    {/* A `building` or `failed` snapshot is invisible to every
                        report, so its counts are shown as pending rather than
                        as a zero somebody could read as an empty organization. */}
                    {s.status === 'complete' ? s.holdingCount.toLocaleString() : '—'}
                  </td>
                  <td>
                    {s.status === 'complete' ? s.unattributableCount : '—'}
                  </td>
                  <td>
                    {s.status === 'complete' ? s.coverageGapCount : (s.error ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
