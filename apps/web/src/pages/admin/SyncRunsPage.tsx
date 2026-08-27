import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface RunRow {
  id: string;
  sourceId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  recordsRead: number;
}

interface SourceRow {
  id: string;
  name: string;
}

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';

// `blocked` gets the danger tone so it is unmissable in a list — it is the
// one status that means a run needs a human decision before anything else
// can happen.
const TONE: Record<string, Tone> = {
  running: 'neutral',
  previewed: 'primary',
  blocked: 'danger',
  applied: 'active',
  partially_applied: 'warning',
  failed: 'danger',
};

const LABEL: Record<string, string> = {
  running: 'Running',
  previewed: 'Previewed',
  blocked: 'Blocked',
  applied: 'Applied',
  partially_applied: 'Partially applied',
  failed: 'Failed',
};

const when = (iso: string) => new Date(iso).toLocaleString();

export function SyncRunsPage() {
  const { data, error, loading } = useApiResource<{ runs: RunRow[] }>(
    '/api/admin/sync-runs',
  );
  // Fetched alongside the runs rather than joined server-side: `listRuns`
  // does not embed the source, and a run row with no indication of which
  // directory it came from is unreadable once more than one source exists.
  const { data: sourcesData } = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/sources',
  );
  const sourceNames = new Map(
    (sourcesData?.sources ?? []).map((source) => [source.id, source.name]),
  );

  return (
    <>
      <PageHeader
        title="Sync runs"
        description="What each run against a directory source read and proposed, newest first."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={6} cols={5} />}

          {!loading && data?.runs.length === 0 && (
            <div className="p-6">
              <Empty title="No sync runs yet">
                Runs appear here once a directory source has been synced, on
                its schedule or by hand.
              </Empty>
            </div>
          )}

          {!loading && data && data.runs.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">
                    Started
                  </th>
                  <th scope="col">
                    Source
                  </th>
                  <th
                    scope="col"
                    className="max-sm:hidden"
                  >
                    Records read
                  </th>
                  <th scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link
                        to={`/admin/sync-runs/${run.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {when(run.startedAt)}
                      </Link>
                    </td>
                    <td>
                      {/* A source that no longer exists still leaves its runs
                          behind; showing the id is better than a blank cell. */}
                      {sourceNames.get(run.sourceId) ?? run.sourceId}
                    </td>
                    <td className="tabular-nums max-sm:hidden">
                      {run.recordsRead}
                    </td>
                    <td>
                      <Status tone={TONE[run.status] ?? 'neutral'}>
                        {LABEL[run.status] ?? run.status}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
