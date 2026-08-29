import { Link } from 'react-router-dom';
import {
  Alert,
  Empty,
  Panel,
  SkeletonRows,
  Status,
  Table,
  buttonClasses,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';

interface PersonSourceRow {
  id: string;
  name: string;
  type: string;
  feedMode: string;
  schedule: string | null;
  autoApply: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  config?: { host?: string; remotePath?: string; hostKeyFingerprint?: string } | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never run');

/**
 * What the file contains, in the words the choice was made in.
 *
 * Shown in the list rather than only in the editor because it is the setting
 * that decides whether somebody missing from tomorrow's file is a leaver, and
 * that is worth seeing across every source at once.
 */
function feed(source: PersonSourceRow): { label: string; tone: 'active' | 'neutral' } {
  return source.feedMode === 'snapshot'
    ? { label: 'Everyone employed', tone: 'active' }
    : { label: 'Changes only', tone: 'neutral' };
}

/**
 * Whether this source can actually run.
 *
 * A source with no pinned host key is configured but inert: `read` refuses
 * without one, so a schedule would fire and fail every night. Saying so on the
 * list turns a recurring failed run into something somebody can fix.
 */
/**
 * Where the export is, as `host:path`.
 *
 * One string rather than two expressions side by side: a value split across
 * text nodes is one a reader's find, and a screen reader, meet in pieces --
 * and without the separator a path that does not begin with `/` ran straight
 * into the hostname.
 */
function fileOf(source: PersonSourceRow): string {
  const host = source.config?.host;
  const path = source.config?.remotePath;
  if (!host) return '—';
  return path ? `${host}:${path}` : host;
}

function pinned(source: PersonSourceRow): boolean {
  const fingerprint = source.config?.hostKeyFingerprint;
  return typeof fingerprint === 'string' && fingerprint !== '';
}

export function PersonSourcesTab() {
  const { data, error, loading } = useApiResource<{ sources: PersonSourceRow[] }>(
    '/api/admin/person-sources',
  );
  const sources = data?.sources ?? [];

  return (
    <>
      {/* The action sits with the table it acts on, as the directory tab's
          does. */}
      <div className="mb-4 flex justify-end">
        <Link to="/admin/person-sources/new" className={buttonClasses('primary')}>
          New person source
        </Link>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={4} cols={6} />}

          {!loading && sources.length === 0 && (
            <div className="p-6">
              <Empty
                title="No people sources yet"
                action={
                  <Link
                    to="/admin/person-sources/new"
                    className={buttonClasses('primary')}
                  >
                    Connect an HR export
                  </Link>
                }
              >
                Read a nightly export and keep the person register in step with it.
              </Empty>
            </div>
          )}

          {!loading && sources.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="max-sm:hidden">
                    File
                  </th>
                  <th scope="col">Contains</th>
                  <th scope="col" className="max-sm:hidden">
                    Schedule
                  </th>
                  <th scope="col">Last run</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <Link to={`/admin/person-sources/${source.id}`}>{source.name}</Link>
                    </td>
                    <td className="max-sm:hidden">{fileOf(source)}</td>
                    <td>
                      <Status tone={feed(source).tone}>{feed(source).label}</Status>
                    </td>
                    <td className="max-sm:hidden">{source.schedule ?? 'Manual only'}</td>
                    <td>{when(source.lastRunAt)}</td>
                    <td>
                      {!source.enabled ? (
                        <Status tone="neutral">Disabled</Status>
                      ) : !pinned(source) ? (
                        <Status tone="danger">Host key not accepted</Status>
                      ) : (
                        <Status tone="active">Enabled</Status>
                      )}
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
