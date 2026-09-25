import { Link } from 'react-router-dom';
import {
  Alert,
  buttonClasses,
  Empty,
  Panel,
  RefreshStatus,
  SkeletonRows,
  Table,
  TableToolbar,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { RunState } from './run-states.js';

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

const when = (iso: string) => new Date(iso).toLocaleString();

/** Which family a run came from, and therefore where its detail page is. */
interface Family {
  label: string;
  detail: (id: string) => string;
}

const DIRECTORY: Family = {
  label: 'Directory',
  detail: (id) => `/admin/sync-runs/${id}`,
};
const PEOPLE: Family = {
  label: 'People',
  detail: (id) => `/admin/person-import-runs/${id}`,
};

/**
 * Every run, of both source families, newest first.
 *
 * One list rather than a tab each: "what ran last night and what did it do" is
 * one question an administrator asks each morning, and two tabs means checking
 * both every time — which is how a blocked import sits unnoticed beside a
 * healthy directory sync.
 *
 * The four collections are fetched separately because neither list endpoint
 * embeds its source, and a run row that cannot say which source it came from
 * is unreadable the moment a tenant has two.
 */
export function RunsTab() {
  const syncRuns = useApiResource<{ runs: RunRow[] }>('/api/admin/sync-runs');
  const importRuns = useApiResource<{ runs: RunRow[] }>('/api/admin/person-import-runs');
  const sources = useApiResource<{ sources: SourceRow[] }>('/api/admin/sources');
  const personSources = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/person-sources',
  );

  const error = syncRuns.error ?? importRuns.error;
  // Skeleton only before the first answer. A refresh keeps the rows on
  // screen, so pressing Refresh does not flash the table away.
  const loaded = syncRuns.data !== null && importRuns.data !== null;
  const refreshing = syncRuns.loading || importRuns.loading;
  // The older of the two: the list is only as fresh as its stalest half.
  const updatedAt =
    syncRuns.updatedAt && importRuns.updatedAt
      ? new Date(Math.min(syncRuns.updatedAt.getTime(), importRuns.updatedAt.getTime()))
      : null;
  const refresh = () => {
    syncRuns.reload();
    importRuns.reload();
  };

  const names = new Map(
    [...(sources.data?.sources ?? []), ...(personSources.data?.sources ?? [])].map(
      (source) => [source.id, source.name],
    ),
  );

  const rows = [
    ...(syncRuns.data?.runs ?? []).map((run) => ({ run, family: DIRECTORY })),
    ...(importRuns.data?.runs ?? []).map((run) => ({ run, family: PEOPLE })),
  ].sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}

      {!error && loaded && (
        <TableToolbar>
          <RefreshStatus updatedAt={updatedAt} onRefresh={refresh} refreshing={refreshing} />
        </TableToolbar>
      )}

      {!error && (
        <Panel>
          {!loaded && <SkeletonRows rows={6} cols={5} />}

          {loaded && rows.length === 0 && (
            <div className="p-6">
              <Empty
                title="No runs yet"
                action={
                  <Link to="/admin/sources?tab=sources" className={buttonClasses('secondary')}>
                    Go to sources
                  </Link>
                }
              >
                Runs appear here once a source has been read, on its schedule or by
                hand.
              </Empty>
            </div>
          )}

          {loaded && rows.length > 0 && (
            <Table stickyHeader label="Runs">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Source</th>
                  <th scope="col">Reads</th>
                  <th scope="col" className="max-sm:hidden">
                    Records read
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ run, family }) => (
                  <tr key={`${family.label}-${run.id}`}>
                    <td>
                      <Link
                        to={family.detail(run.id)}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {when(run.startedAt)}
                      </Link>
                    </td>
                    <td>
                      {/* A source that no longer exists still leaves its runs
                          behind; showing the id is better than a blank cell. */}
                      {names.get(run.sourceId) ?? run.sourceId}
                    </td>
                    <td>{family.label}</td>
                    <td className="tabular-nums max-sm:hidden">{run.recordsRead}</td>
                    <td>
                      <RunState status={run.status} />
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
