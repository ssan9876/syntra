import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Table, useToast } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { RunState } from './run-states.js';

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

export function GovernSnapshotsTab() {
  const { data, error, loading, reload } = useApiResource<{ snapshots: SnapshotRow[] }>(
    '/api/admin/govern/snapshots',
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const toast = useToast();
  // Narrowed once: a 200 without its collection must render an empty table,
  // not blank the console.
  const snapshots = data?.snapshots ?? [];

  const build = () => {
    setBuilding(true);
    void api('/api/admin/govern/snapshots', {
      method: 'POST',
      body: JSON.stringify({ kind: 'manual' }),
    })
      .then(() => {
        setActionError(null);
        toast({ title: 'Snapshot started' });
        reload();
      })
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'Could not build a snapshot.',
        ),
      )
      .finally(() => setBuilding(false));
  };

  return (
    <>
      {/* The action sits with the table it acts on. One header above
          several tabs would need a word saying which tab its button
          applied to. */}
      {/* On an empty list the empty state carries this button instead. */}
      {!(data && snapshots.length === 0) && (
        <div className="mb-4 flex justify-end">
          <Button loading={building} onClick={build}>
            Build a snapshot now
          </Button>
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      <Panel>
        {!data && loading && <SkeletonRows rows={6} cols={5} />}
        {data && snapshots.length === 0 && (
          <div className="p-6">
            <Empty
              title="No snapshots yet"
              action={
                <Button variant="primary" loading={building} onClick={build}>
                  Build a snapshot now
                </Button>
              }
            >
              Build one and the inventory, the coverage register and the standing findings
              appear on their own.
            </Empty>
          </div>
        )}
        {snapshots.length > 0 && (
          <Table stickyHeader label="Snapshots">
            <thead>
              <tr>
                <th scope="col">As of</th>
                <th scope="col">Status</th>
                <th scope="col">Holdings</th>
                <th scope="col">Nobody can explain</th>
                <th scope="col">Coverage gaps</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link className="link" to={`/admin/govern/snapshots/${s.id}`}>
                      {new Date(s.asOf).toLocaleString()}
                    </Link>
                  </td>
                  <td>
                    <RunState status={s.status} />
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
