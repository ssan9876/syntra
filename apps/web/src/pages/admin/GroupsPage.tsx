import { Alert, Empty, Panel, SkeletonRows } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
}

export function GroupsPage() {
  const { data, error, loading } = useApiResource<{ groups: GroupRow[] }>(
    '/api/admin/groups',
  );

  return (
    <>
      <PageHeader
        title="Groups"
        description="Collections of users. Access is granted to groups rather than to people one at a time."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={4} cols={2} />}

          {!loading && data?.groups.length === 0 && (
            <div className="p-6">
              <Empty title="No groups yet">
                Create a group to grant the same access to several people at
                once instead of repeating it per person.
              </Empty>
            </div>
          )}

          {!loading && data && data.groups.length > 0 && (
            <ul>
              {data.groups.map((group) => (
                <li
                  key={group.id}
                  className="flex flex-wrap items-baseline gap-x-3 border-b border-border-subtle px-4 py-3 last:border-0 transition-colors hover:bg-surface"
                >
                  <span className="font-medium text-ink">{group.name}</span>
                  {group.description && (
                    <span className="text-muted">{group.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </>
  );
}
