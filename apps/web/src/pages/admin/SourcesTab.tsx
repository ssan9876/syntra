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

interface SourceRow {
  id: string;
  name: string;
  type: string;
  schedule: string | null;
  autoApply: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  config?: {
    url?: string;
    tlsMode?: string;
    rejectUnauthorized?: boolean;
  } | null;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : 'Never run';

/**
 * How the bind password and everything after it travel. Named plainly, per
 * the design's section 8: a source binding in the clear should say so on the
 * page an administrator already looks at, not only in a JSON blob.
 *
 * A source saved before the mode existed carries no `tlsMode`, so the URL
 * scheme stands in for it — the same rule `ldapConfigSchema` applies when it
 * resolves an absent mode, so the page and the connector cannot disagree about
 * a legacy source. Falling through to "Not encrypted" for such a source would
 * err safely but would still be wrong, and a label that is wrong in a
 * predictable direction is a label nobody ends up believing.
 */
function transport(source: SourceRow): { label: string; tone: 'active' | 'danger' } {
  const mode =
    source.config?.tlsMode ??
    (source.config?.url?.trim().toLowerCase().startsWith('ldaps:')
      ? 'ldaps'
      : 'plain');

  switch (mode) {
    case 'ldaps':
      return { label: 'LDAPS', tone: 'active' };
    case 'starttls':
      return { label: 'StartTLS', tone: 'active' };
    default:
      return { label: 'Not encrypted', tone: 'danger' };
  }
}

export function SourcesTab() {
  const { data, error, loading } = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/sources',
  );
  // Narrowed once. The optional chain used to guard `data` and then walk
  // straight into the collection, so a 200 arriving without it threw inside
  // render and blanked the console instead of showing an empty table.
  const sources = data?.sources ?? [];


  return (
    <>
      {/* The action sits with the table it acts on. One header above
          several tabs would need a word saying which tab its button
          applied to. */}
      <div className="mb-4 flex justify-end">
        <Link
            to="/admin/sources/new"
            className={buttonClasses('primary')}
          >
            New source
          </Link>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={4} cols={5} />}

          {!loading && sources.length === 0 && (
            <div className="p-6">
              <Empty
                title="No directory sources yet"
                action={
                  <Link
                    to="/admin/sources/new"
                    className={buttonClasses('primary')}
                  >
                    Connect a directory
                  </Link>
                }
              >
                Connect one to bring users and groups in automatically.
              </Empty>
            </div>
          )}

          {!loading && sources.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">
                    Name
                  </th>
                  <th
                    scope="col"
                    className="max-sm:hidden"
                  >
                    Schedule
                  </th>
                  <th scope="col">
                    Transport
                  </th>
                  <th scope="col">
                    Auto-apply
                  </th>
                  <th scope="col">
                    Last run
                  </th>
                  <th scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <Link
                        to={`/admin/sources/${source.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {source.name}
                      </Link>
                      <span className="ml-2 text-sm text-muted">
                        {source.type}
                      </span>
                    </td>
                    <td className="max-sm:hidden">
                      {source.schedule ?? 'Manual only'}
                    </td>
                    <td>
                      <Status tone={transport(source).tone}>
                        {transport(source).label}
                      </Status>
                      {source.config?.rejectUnauthorized === false && (
                        <span className="ml-2 text-sm text-warning">
                          Certificate not verified
                        </span>
                      )}
                    </td>
                    <td>
                      <Status tone={source.autoApply ? 'primary' : 'neutral'}>
                        {source.autoApply ? 'On' : 'Off'}
                      </Status>
                    </td>
                    <td>
                      {when(source.lastRunAt)}
                    </td>
                    <td>
                      <Status tone={source.enabled ? 'active' : 'inactive'}>
                        {source.enabled ? 'Enabled' : 'Disabled'}
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
