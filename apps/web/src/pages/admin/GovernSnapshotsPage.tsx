import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

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

export function GovernSnapshotsPage() {
  const { data, error, loading, reload } = useApiResource<{ snapshots: SnapshotRow[] }>(
    '/api/admin/govern/snapshots',
  );
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Snapshots"
        description="Each one is a point-in-time picture of who can reach what. A certification is always against one of these, never against a live query."
        actions={
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
        }
      />

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
        {!loading && data && data.snapshots.length > 0 && (
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
              {data.snapshots.map((s) => (
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
