import { Link } from 'react-router-dom';
import { Alert, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
import { PageHeader } from './PageHeader.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  statusReason: string | null;
  sourceId: string | null;
}

export function GroupsPage() {
  const { data, error, loading, reload } = useApiResource<{ groups: GroupRow[] }>(
    '/api/admin/groups',
  );
  // Narrowed once, and reused by both the summary cards and the table.
  // The optional chain used to guard `data` and then walk straight into
  // the collection, so a 200 arriving without it threw inside render.
  const groups = data?.groups ?? [];

  return (
    <>
      <PageHeader
        title="Groups"
      />

      <StatGrid>
        <StatCard label="Groups" value={groups.length} />
        <StatCard label="From a directory" value={groups.filter((g) => g.sourceId !== null).length} />
        <StatCard
          label="Inactive"
          value={groups.filter((g) => g.status !== 'active').length}
          tone="warning"
          quietWhenZero
        />
      </StatGrid>

      {error && <Alert tone="danger">{error}</Alert>}

      <RecordPanel
        title="New group"
        submitLabel="New group"
        path="/api/admin/groups"
        onCreated={reload}
        build={(v) => ({
          name: v.name ?? '',
          // Omitted rather than sent empty: the schema takes `description` as
          // optional, and an empty string is a description somebody wrote.
          ...(v.description ? { description: v.description } : {}),
        })}
        fields={(v, set, errs) => (
          <>
            <Field
              label="Name"
              value={v.name ?? ''}
              onChange={(x) => set('name', x)}
              error={errs.name}
              placeholder="Ward Nurses"
            />
            <Field
              label="Description"
              value={v.description ?? ''}
              onChange={(x) => set('description', x)}
              error={errs.description}
            />
          </>
        )}
      />

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
                  className="flex flex-wrap items-center gap-x-3 border-b border-border-subtle px-4 py-3 last:border-0 transition-colors hover:bg-surface"
                >
                  {/* A row opens a record. Edit, Members and the status
                      control lived here; each of them needs a sentence to say
                      what it is about to do, and a cell has no room for one. */}
                  <Link
                    to={`/admin/groups/${group.id}`}
                    className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                  >
                    {group.name}
                  </Link>
                  {group.description && (
                    <span className="text-muted">{group.description}</span>
                  )}
                  {group.status !== 'active' && (
                    // LABELLED, not hidden. A deactivated group keeps its
                    // members and grants nothing, and an administrator needs
                    // to see that it is still there and why.
                    <Status tone="inactive">
                      {group.statusReason
                        ? `inactive — ${group.statusReason}`
                        : 'inactive'}
                    </Status>
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
