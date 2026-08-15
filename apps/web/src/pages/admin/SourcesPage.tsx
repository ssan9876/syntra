import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

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

export function SourcesPage() {
  const { data, error, loading } = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/sources',
  );

  return (
    <>
      <PageHeader
        title="Directory sources"
        description="Where users, groups, and org units are read from before a sync run proposes changes."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={4} cols={5} />}

          {!loading && data?.sources.length === 0 && (
            <div className="p-6">
              <Empty title="No directory sources yet">
                Connect one to bring users and groups in automatically.
              </Empty>
            </div>
          )}

          {!loading && data && data.sources.length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Name
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 font-medium max-sm:hidden"
                  >
                    Schedule
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Transport
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Auto-apply
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Last run
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((source) => (
                  <tr
                    key={source.id}
                    className="border-b border-border-subtle last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-ink">
                        {source.name}
                      </span>
                      <span className="ml-2 text-sm text-muted">
                        {source.type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted max-sm:hidden">
                      {source.schedule ?? 'Manual only'}
                    </td>
                    <td className="px-4 py-2.5">
                      <Status tone={transport(source).tone}>
                        {transport(source).label}
                      </Status>
                      {source.config?.rejectUnauthorized === false && (
                        <span className="ml-2 text-sm text-warning">
                          Certificate not verified
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Status tone={source.autoApply ? 'primary' : 'neutral'}>
                        {source.autoApply ? 'On' : 'Off'}
                      </Status>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {when(source.lastRunAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Status tone={source.enabled ? 'active' : 'inactive'}>
                        {source.enabled ? 'Enabled' : 'Disabled'}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
