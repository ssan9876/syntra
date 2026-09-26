import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  ColumnPicker,
  DensityToggle,
  Empty,
  Field,
  ListControls,
  Pager,
  Panel,
  Select,
  SkeletonRows,
  StateBadge,
  Status,
  Table,
  TableToolbar,
  buttonClasses,
  useDensity,
  useHiddenColumns,
  type ColumnDef,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PickerNote } from './PickerNote.js';
import { RecordPanel } from './RecordPanel.js';
import { orgUnitLabel, type EffectiveOrgUnit } from './org-unit-label.js';

interface UserRow {
  id: string;
  login: string;
  displayName: string;
  email: string;
  status: string;
  statusReason: string | null;
  /** Set when a directory source owns this account. Null means locally managed. */
  sourceId: string | null;
  /**
   * Too many failed sign-ins. Orthogonal to `status`: a locked account is
   * active and cannot sign in, which is a different sentence from an inactive
   * one and needs its own label.
   */
  locked?: boolean;
  /** The unit app access resolves through, own or inherited. See `orgUnitLabel`. */
  effectiveOrgUnit?: EffectiveOrgUnit | null;
}

interface SourceRow {
  id: string;
  name: string;
}

interface PersonRow {
  id: string;
  givenName: string;
  familyName: string;
  status: string;
  /**
   * Their own placement unit, which outranks anything picked on this form.
   *
   * Carried so the form can say so. A unit chosen here reaches the person only
   * when theirs is null — overwriting it would undo a decision made about the
   * person from a form whose subject is the account — and somebody who is not
   * told that reads the picker as having applied.
   */
  orgUnitId: string | null;
}

/**
 * The account table's columns. The name is the way into the record and the
 * status is what the list is scanned for, so neither can be hidden; the rest
 * are the reader's to trim on a narrow console.
 */
const COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', required: true },
  { id: 'login', label: 'Login' },
  { id: 'email', label: 'Email' },
  { id: 'managedBy', label: 'Managed by' },
  { id: 'orgUnit', label: 'Org unit' },
  { id: 'status', label: 'Status', required: true },
];

/**
 * The accounts, as a list and nothing else.
 *
 * Every control that used to live on a row is now on the account's own screen,
 * reached by clicking its name. The row actions were not merely crowded — they
 * forced this component to hold six pieces of state that were each only ever
 * about ONE account (which row is being edited, whose setup link is on screen,
 * whose factors are open, which unlock is in flight), and the consequence of
 * that shape was that clicking an account did nothing at all. Reading an
 * account meant reading a table row, and the account's history meant reading
 * the whole audit log.
 *
 * What is left here is what a list is for: seeing which accounts exist, which
 * are inactive or locked, and which are owned by a directory. Creating one
 * stays, because that is an action on the collection rather than on a member
 * of it.
 */
export function AccountsTab() {
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

  const [density, setDensity] = useDensity('accounts');
  const [hidden, setHidden] = useHiddenColumns('accounts');
  const shows = (column: string) => !hidden.has(column);

  const { data, error, loading, reload } = useApiResource<{
    users: UserRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/admin/users${qs ? `?${qs}` : ''}`);

  // Every control writes through the URL, as People does: same page, same
  // convention, and a link to a filtered list is worth sending to somebody.
  const update = useCallback(
    (next: Record<string, string>, replaceHistory = false) => {
      const merged = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) merged.set(key, value);
        else merged.delete(key);
      }
      // `replace` only for the debounced search, as People does. A page and a
      // status are decisions somebody clicked, and Back has to undo a filter
      // rather than leave the console.
      setParams(merged, { replace: replaceHistory });
    },
    [params, setParams],
  );

  const onSearch = useCallback(
    (value: string) => update({ q: value, page: '' }, true),
    [update],
  );
  const onStatus = useCallback((value: string) => update({ status: value, page: '' }), [update]);
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);
  // For the org-unit picker on the create form. A caller without
  // `directory.read` on units gets an empty list and a form that still works,
  // rather than a page that will not render.
  const { data: unitsData } = useApiResource<{ orgUnits: { id: string; name: string }[] }>(
    '/api/admin/org-units',
  );
  // Fetched alongside the users so a synced account can name the directory
  // that owns it. A caller holding directory.read but not sync.read gets a 403
  // here; the hook turns that into its own error state, which is deliberately
  // ignored — a missing source name is not a reason to fail the page, and the
  // row still says the account is managed elsewhere.
  const { data: sourcesData } = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/sources',
  );
  // For the person picker. Its error state is tolerated like the sources read
  // above: a caller who may create accounts but not read people gets a picker
  // holding only "service account", and a form that still works.
  // `status=active` is the SERVER's filter rather than a narrowing of the page
  // it sends back, so `total` counts the same set the picker is built from.
  // Filtering a fetched page here left the note beside it saying "the first 200
  // of 5,000" over a picker holding whatever fraction of those 200 was active.
  const { data: personsData } = useApiResource<{ persons: PersonRow[]; total: number }>(
    '/api/admin/persons?status=active&pageSize=200',
  );
  const people = personsData?.persons ?? [];
  const sourceNames = new Map(
    (sourcesData?.sources ?? []).map((source) => [source.id, source.name]),
  );
  // Same narrowing as PeopleTab, and for the same reason: a 200 without its
  // collection must render an empty table, not a blank console.
  const users = data?.users ?? [];
  const total = data?.total ?? users.length;
  const shownPageSize = data?.pageSize ?? 50;
  const filtered = q !== '' || status !== '';

  return (
    <>
      <ListControls
        search={q}
        onSearch={onSearch}
        searchLabel="Search accounts"
        searchPlaceholder="Login, display name or work email"
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
        title="New user"
        submitLabel="New user"
        path="/api/admin/users"
        onCreated={reload}
        build={(v) => ({
          login: v.login ?? '',
          email: v.email ?? '',
          // Falls back to the login rather than being sent empty: the schema
          // requires a display name, and "what shall I call this account" has
          // an obvious answer when nobody typed one.
          displayName: v.displayName?.trim() ? v.displayName : (v.login ?? ''),
          ...(v.orgUnitId ? { orgUnitId: v.orgUnitId } : {}),
          // Three states, sent as three different bodies. `'none'` becomes a
          // literal null, which is what says "service account" to the API; the
          // empty string is OMITTED, which is what asks it to match. Collapsing
          // them would turn "work it out" into "there is nobody".
          //
          // The option is labelled "service account", so it creates one: the
          // account's password is then not forced to change when an
          // administrator sets it, and its API tokens are not stopped by a
          // pending renewal. Reversible on the account's own screen.
          ...(v.personId === 'none'
            ? { personId: null, kind: 'service' }
            : v.personId
              ? { personId: v.personId }
              : {}),
        })}
        confirmable={(problem) =>
          problem.type.endsWith('second-account')
            ? {
                message: problem.detail ?? problem.title,
                retryWith: { allowSecondAccount: true },
              }
            : null
        }
        fields={(v, set, errs) => (
          <>
            <Field
              label="Login"
              value={v.login ?? ''}
              name="login"
              onChange={(x) => set('login', x)}
              error={errs.login}
              placeholder="mokafor"
            />
            <Field
              label="Email"
              value={v.email ?? ''}
              name="email"
              onChange={(x) => set('email', x)}
              error={errs.email}
              type="email"
              placeholder="maya.okafor@acme.localhost"
            />
            <Field
              label="Display name"
              value={v.displayName ?? ''}
              name="displayName"
              onChange={(x) => set('displayName', x)}
              error={errs.displayName}
              placeholder="Maya Okafor"
            />
            <Select
              label="Person"
              value={v.personId ?? ''}
              name="personId"
              onChange={(x) => set('personId', x)}
              error={errs.personId}
              options={[
                // The blank is "work it out", not "nobody". An account whose
                // address matches exactly one person's work email is linked;
                // anything less certain is left alone and offered on the
                // account's own screen afterwards.
                { value: '', label: 'Match by email' },
                { value: 'none', label: 'No person — service account' },
                ...people.map((p) => ({
                  value: p.id,
                  label: `${p.givenName} ${p.familyName}`,
                })),
              ]}
            />
            <PickerNote
              shown={people.length}
              total={personsData?.total ?? people.length}
              to="/admin/users?tab=people"
              label="People"
            />
            {(() => {
              // Said only when it changes the answer. The account always takes
              // the unit picked here — that is access resolution — but
              // PLACEMENT follows the person's own unit, and this form does not
              // overwrite one they already have.
              const chosen = people.find((p) => p.id === v.personId);
              const placedIn = chosen?.orgUnitId
                ? ((unitsData?.orgUnits ?? []).find((u) => u.id === chosen.orgUnitId)?.name ??
                  'another unit')
                : null;
              return (
                <Select
                  label="Org unit"
                  value={v.orgUnitId ?? ''}
                  name="orgUnitId"
                  onChange={(x) => set('orgUnitId', x)}
                  error={errs.orgUnitId}
                  warning={
                    chosen && placedIn
                      ? `${chosen.givenName} ${chosen.familyName} is already placed in ${placedIn} — access only`
                      : undefined
                  }
                  options={[
                    { value: '', label: 'None' },
                    ...(unitsData?.orgUnits ?? []).map((u) => ({ value: u.id, label: u.name })),
                  ]}
                />
              );
            })()}
          </>
        )}
      />

      {/* NO PASSWORD FIELD, and that is deliberate rather than unfinished.
          There is no admin endpoint that sets one — `POST /users` does not
          take a password and nothing else does either. A new account signs in
          through a directory source, an upstream identity provider, or a
          password reset. Offering a box here would be offering a control the
          product does not have. */}

      {!error && data && users.length > 0 && (
        <TableToolbar>
          <ColumnPicker columns={COLUMNS} hidden={hidden} onChange={setHidden} />
          <DensityToggle value={density} onChange={setDensity} />
        </TableToolbar>
      )}

      {!error && (
        <Panel>
          {/* Skeleton only before the first answer. A search or a page
              change keeps the previous rows on screen until the next arrive. */}
          {!data && loading && <SkeletonRows rows={6} cols={4} />}

          {data && users.length === 0 && total === 0 && !filtered && (
            <div className="p-6">
              <Empty
                title="No users yet"
                action={
                  <Link to="/admin/sources/new" className={buttonClasses('primary')}>
                    Connect a directory
                  </Link>
                }
                secondaryAction={
                  <Link to="/admin/users?tab=people" className="link">
                    Start from a person instead
                  </Link>
                }
              />
            </div>
          )}

          {data && users.length === 0 && total === 0 && filtered && (
            <div className="p-6">
              <Empty
                title={`No account matches ${q || status}`}
                action={
                  <button
                    type="button"
                    className={buttonClasses('secondary')}
                    onClick={() => update({ q: '', status: '', page: '' })}
                  >
                    Reset filters
                  </button>
                }
              />
            </div>
          )}

          {/* A page past the end, which is what a shared `?page=9` becomes once
              the accounts it named are gone. The rows are empty and the
              directory is not, so the unfiltered empty state would say "No
              users yet" over thousands of accounts -- and the pager it used to
              be gated with was the only way back. */}
          {data && users.length === 0 && total > 0 && (
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

          {users.length > 0 && (
            <Table stickyHeader label="Accounts" density={density}>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  {shows('login') && <th scope="col">Login</th>}
                  {shows('email') && (
                    <th scope="col" className="max-sm:hidden">
                      Email
                    </th>
                  )}
                  {shows('managedBy') && <th scope="col">Managed by</th>}
                  {shows('orgUnit') && <th scope="col">Org unit</th>}
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {/* The name is the way in, as it is on People. A row
                          that carried its own controls and no link was a row
                          that could not be opened. */}
                      <Link
                        to={`/admin/users/${user.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {user.displayName}
                      </Link>
                    </td>
                    {shows('login') && <td>{user.login}</td>}
                    {shows('email') && <td className="max-sm:hidden">{user.email}</td>}
                    {shows('managedBy') && (
                    <td>
                      {!user.sourceId ? (
                        <span className="text-muted">Syntra</span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-2">
                          {/* Named, not merely flagged: "synced" tells an
                              administrator nothing about where to go and
                              change it. The generic word stands in when the
                              caller cannot read the source list. */}
                          <Status tone="primary">
                            {sourceNames.get(user.sourceId) ?? 'Directory source'}
                          </Status>
                          <span className="text-sm text-muted">read-only</span>
                        </span>
                      )}
                    </td>
                    )}
                    {shows('orgUnit') && (
                      <td>
                        {orgUnitLabel(user.effectiveOrgUnit) ?? (
                          <span className="text-muted">None</span>
                        )}
                      </td>
                    )}
                    <td>
                      {/*
                        Inactive accounts stay listed and labelled. Hiding a
                        deactivation to keep the table tidy would make the
                        directory unauditable.
                      */}
                      {user.status === 'active' ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <StateBadge state="healthy">Active</StateBadge>
                          {/* Blocked, not a caution: a locked account cannot
                              sign in until somebody unlocks it. */}
                          {user.locked && <StateBadge state="blocked">Locked out</StateBadge>}
                        </span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-2">
                          <StateBadge state="inactive">Inactive</StateBadge>
                          {user.statusReason && (
                            <span className="text-sm text-muted">
                              {user.statusReason}
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

      {/* Not gated on the rows: see PeopleTab. */}
      {!error && data && (
        <Pager page={page} pageSize={shownPageSize} total={total} onPage={onPage} />
      )}
    </>
  );
}
