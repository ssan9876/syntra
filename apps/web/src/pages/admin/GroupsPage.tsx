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
  Table,
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
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (status) query.set('status', status);
  if (page > 1) query.set('page', String(page));
  // Carried through rather than fixed here: the route caps it at 200, so
  // this is a knob for a reader who wants a longer page and for the
  // end-to-end test that needs a short one -- not a way to ask for
  // everything.
  const pageSize = params.get('pageSize');
  if (pageSize) query.set('pageSize', pageSize);
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
  //
  // `/groups/summary`, NOT `/directory/summary`. The combined one spans both
  // halves of the directory and so demands `identity.read` as well, which this
  // screen needs for nothing else: a group administrator got a 403 there and
  // three confident zeroes above a table listing thousands of groups.
  const { data: summary, error: summaryError } = useApiResource<{
    groups: { total: number; fromDirectory: number; inactive: number };
  }>('/api/admin/groups/summary');

  const update = useCallback(
    (next: Record<string, string>, replaceHistory = false) => {
      const merged = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) merged.set(key, value);
        else merged.delete(key);
      }
      // `replace` only for the debounced search, which is this screen acting
      // on a settled keystroke rather than on a click. A page and a status are
      // decisions, and the back button should undo a filter rather than leave
      // the screen.
      setParams(merged, { replace: replaceHistory });
    },
    [params, setParams],
  );

  const onSearch = useCallback(
    (value: string) => update({ q: value, page: '' }, true),
    [update],
  );
  const onStatus = useCallback(
    (value: string) => update({ status: value, page: '' }),
    [update],
  );
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);
  // Narrowed once, and reused by both the summary cards and the table.
  // The optional chain used to guard `data` and then walk straight into
  // the collection, so a 200 arriving without it threw inside render.
  const groups = data?.groups ?? [];
  const total = data?.total ?? groups.length;
  const shownPageSize = data?.pageSize ?? 50;
  const counts = summary?.groups;
  const filtered = q !== '' || status !== '';
  /**
   * What a card shows when the count could not be read.
   *
   * A nought is a measurement. Rendering one for a refusal states as fact that
   * there are no groups, directly above a table listing them; the dash is what
   * this console's tables already use for a value that is not there to show.
   */
  const figure = (value: number | undefined) =>
    summaryError || value === undefined ? '—' : value;

  return (
    <>
      <PageHeader title="Groups" />

      <StatGrid>
        <StatCard label="Groups" value={figure(counts?.total)} />
        <StatCard label="From a directory" value={figure(counts?.fromDirectory)} />
        <StatCard
          label="Inactive"
          value={figure(counts?.inactive)}
          tone="warning"
          quietWhenZero
        />
      </StatGrid>

      <ListControls
        search={q}
        onSearch={onSearch}
        searchLabel="Search groups"
        searchPlaceholder="Name or description"
        // The card above advertises the inactive groups; without this the only
        // way to act on that figure was to read every page looking for them.
        status={{
          value: status,
          onChange: onStatus,
          options: [
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ],
        }}
      />
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
          {loading && <SkeletonRows rows={4} cols={3} />}

          {!loading && groups.length === 0 && total === 0 && !filtered && (
            <div className="p-6">
              <Empty title="No groups yet">
                Create a group to grant the same access to several people at
                once instead of repeating it per person.
              </Empty>
            </div>
          )}

          {!loading && groups.length === 0 && total === 0 && filtered && (
            <div className="p-6">
              <Empty
                title={`No group matches ${q || status}`}
                action={
                  <button
                    type="button"
                    className={buttonClasses('secondary')}
                    onClick={() => update({ q: '', status: '', page: '' })}
                  >
                    Clear the search
                  </button>
                }
              >
                Group names and descriptions are searched.
              </Empty>
            </div>
          )}

          {/* A page past the end, which is what a bookmarked `?page=9` becomes
              once the groups it named are gone. The rows are empty and the
              tenant is not, so the unfiltered state would say "No groups yet"
              over thousands of them. */}
          {!loading && groups.length === 0 && total > 0 && (
            <div className="p-6">
              <Empty
                title={`Page ${page} is past the end`}
                action={
                  <button
                    type="button"
                    className={buttonClasses('primary')}
                    onClick={() => update({ page: '' })}
                  >
                    Go to the first page
                  </button>
                }
              />
            </div>
          )}

          {/* `Table`, as every other list in the product uses. The
              hand-written list here carried its own padding, which is exactly
              how the console came to have several row heights. */}
          {!loading && groups.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="max-sm:hidden">
                    Description
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td>
                      {/* A row opens a record. Edit, Members and the status
                          control lived here; each of them needs a sentence to
                          say what it is about to do, and a cell has no room
                          for one. */}
                      <Link
                        to={`/admin/groups/${group.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {group.name}
                      </Link>
                    </td>
                    <td className="max-sm:hidden">{group.description ?? '—'}</td>
                    <td>
                      {group.status === 'active' ? (
                        <Status tone="active">Active</Status>
                      ) : (
                        // LABELLED, not hidden. A deactivated group keeps its
                        // members and grants nothing, and an administrator
                        // needs to see that it is still there and why.
                        <span className="flex flex-wrap items-center gap-2">
                          <Status tone="inactive">Inactive</Status>
                          {group.statusReason && (
                            <span className="text-sm text-muted">
                              {group.statusReason}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}

      {/* Not gated on the rows: the count is the answer to "how many are
          there", and on a page past the end the pager is the way back. */}
      {!error && !loading && (
        <Pager page={page} pageSize={shownPageSize} total={total} onPage={onPage} />
      )}
    </>
  );
}
