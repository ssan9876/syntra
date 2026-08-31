import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Empty,
  Field,
  ListControls,
  Pager,
  Panel,
  SkeletonRows,
  Status,
  buttonClasses,
} from '@syntra/ui';
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
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (page > 1) query.set('page', String(page));
  const qs = query.toString();

  const { data, error, loading, reload } = useApiResource<{
    groups: GroupRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/admin/groups${qs ? `?${qs}` : ''}`);

  // The cards count the whole table. They used to filter the fetched array,
  // which paging turns into three page-sized numbers that still read as
  // totals -- worse than showing nothing.
  const { data: summary } = useApiResource<{
    groups: { total: number; fromDirectory: number; inactive: number };
  }>('/api/admin/directory/summary');

  const update = useCallback(
    (next: Record<string, string>) => {
      const merged = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) merged.set(key, value);
        else merged.delete(key);
      }
      setParams(merged, { replace: true });
    },
    [params, setParams],
  );

  const onSearch = useCallback((value: string) => update({ q: value, page: '' }), [update]);
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);
  // Narrowed once, and reused by both the summary cards and the table.
  // The optional chain used to guard `data` and then walk straight into
  // the collection, so a 200 arriving without it threw inside render.
  const groups = data?.groups ?? [];
  const total = data?.total ?? groups.length;
  const pageSize = data?.pageSize ?? 50;
  const counts = summary?.groups;

  return (
    <>
      <PageHeader
        title="Groups"
      />

      <StatGrid>
        <StatCard label="Groups" value={counts?.total ?? 0} />
        <StatCard label="From a directory" value={counts?.fromDirectory ?? 0} />
        <StatCard
          label="Inactive"
          value={counts?.inactive ?? 0}
          tone="warning"
          quietWhenZero
        />
      </StatGrid>

      <ListControls search={q} onSearch={onSearch} searchLabel="Search groups" />
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

          {!loading && groups.length === 0 && q === '' && (
            <div className="p-6">
              <Empty title="No groups yet">
                Create a group to grant the same access to several people at
                once instead of repeating it per person.
              </Empty>
            </div>
          )}

          {!loading && groups.length === 0 && q !== '' && (
            <div className="p-6">
              <Empty
                title={`No group matches ${q}`}
                action={
                  <button
                    type="button"
                    className={buttonClasses('secondary')}
                    onClick={() => update({ q: '', page: '' })}
                  >
                    Clear the search
                  </button>
                }
              >
                Group names and descriptions are searched.
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

      {!error && !loading && groups.length > 0 && (
        <Pager page={page} pageSize={pageSize} total={total} onPage={onPage} />
      )}
    </>
  );
}
