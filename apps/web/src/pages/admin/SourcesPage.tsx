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
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : 'Never run';

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
