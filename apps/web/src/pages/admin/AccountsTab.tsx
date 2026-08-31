import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Empty,
  Field,
  ListControls,
  Pager,
  Panel,
  Select,
  SkeletonRows,
  Status,
  Table,
  buttonClasses,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PickerNote } from './PickerNote.js';
import { RecordPanel } from './RecordPanel.js';

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
  const qs = query.toString();

  const { data, error, loading, reload } = useApiResource<{
    users: UserRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/admin/users${qs ? `?${qs}` : ''}`);

  // Every control writes through the URL, as People does: same page, same
  // convention, and a link to a filtered list is worth sending to somebody.
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
  const { data: personsData } = useApiResource<{ persons: PersonRow[]; total: number }>(
    '/api/admin/persons?pageSize=200',
  );
  const people = (personsData?.persons ?? []).filter((p) => p.status === 'active');
  const sourceNames = new Map(
    (sourcesData?.sources ?? []).map((source) => [source.id, source.name]),
  );
  // Same narrowing as PeopleTab, and for the same reason: a 200 without its
  // collection must render an empty table, not a blank console.
  const users = data?.users ?? [];
  const anySynced = users.some((user) => Boolean(user.sourceId));
  const total = data?.total ?? users.length;
  const pageSize = data?.pageSize ?? 50;
  const filtered = q !== '' || status !== '';

  return (
    <>
      <ListControls
        search={q}
        onSearch={onSearch}
        searchLabel="Search accounts"
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
          ...(v.personId === 'none'
            ? { personId: null }
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
              onChange={(x) => set('login', x)}
              error={errs.login}
              placeholder="mokafor"
            />
            <Field
              label="Email"
              value={v.email ?? ''}
              onChange={(x) => set('email', x)}
              error={errs.email}
              type="email"
              placeholder="maya.okafor@acme.localhost"
            />
            <Field
              label="Display name"
              value={v.displayName ?? ''}
              onChange={(x) => set('displayName', x)}
              error={errs.displayName}
              placeholder="Maya Okafor"
            />
            <Select
              label="Person"
              value={v.personId ?? ''}
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
              shown={personsData?.persons?.length ?? 0}
              total={personsData?.total ?? 0}
              to="/admin/users?tab=people"
              label="People"
            />
            <Select
              label="Org unit"
              value={v.orgUnitId ?? ''}
              onChange={(x) => set('orgUnitId', x)}
              error={errs.orgUnitId}
              options={[
                { value: '', label: 'None' },
                ...(unitsData?.orgUnits ?? []).map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
            {/*
              Said only when it changes the answer. The account always takes
              the unit picked here — that is access resolution — but PLACEMENT
              follows the person's own unit, and this form does not overwrite
              one they already have. Without this line the picker looks like it
              decided where their account will be created, and it did not.
            */}
            {(() => {
              const chosen = people.find((p) => p.id === v.personId);
              if (!chosen?.orgUnitId) return null;
              const unit = (unitsData?.orgUnits ?? []).find(
                (u) => u.id === chosen.orgUnitId,
              );
              return (
                <p className="text-sm text-muted sm:col-span-2">
                  {chosen.givenName} {chosen.familyName} is already placed in{' '}
                  {unit?.name ?? 'another unit'}, and their account will be
                  created there. The unit above applies to this login's access
                  only.
                </p>
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

      {!error && anySynced && (
        // Said once, above the table, and again on the account's own screen.
        // An administrator who edits the wrong account would have their change
        // overwritten by the next run without explanation.
        <div className="mb-4">
          <Alert tone="info" title="Some of these accounts are managed elsewhere">
            An account with a directory source named against it has its login,
            name and email owned by that directory: the fields are read-only
            here and are rewritten on every run. Change them in the directory
            itself.
          </Alert>
        </div>
      )}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={6} cols={4} />}

          {!loading && users.length === 0 && !filtered && (
            <div className="p-6">
              <Empty title="No users yet">
                Users appear here once they are created, or once a directory
                synchronization brings them in.
              </Empty>
            </div>
          )}

          {!loading && users.length === 0 && filtered && (
            <div className="p-6">
              <Empty
                title={`No account matches ${q || status}`}
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
                Logins, display names and work email addresses are searched.
              </Empty>
            </div>
          )}

          {!loading && users.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Login</th>
                  <th scope="col" className="max-sm:hidden">
                    Email
                  </th>
                  <th scope="col">Managed by</th>
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
                    <td>{user.login}</td>
                    <td className="max-sm:hidden">{user.email}</td>
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
                    <td>
                      {/*
                        Inactive accounts stay listed and labelled. Hiding a
                        deactivation to keep the table tidy would make the
                        directory unauditable.
                      */}
                      {user.status === 'active' ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <Status tone="active">Active</Status>
                          {user.locked && <Status tone="warning">Locked out</Status>}
                        </span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-2">
                          <Status tone="inactive">Inactive</Status>
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

      {!error && !loading && users.length > 0 && (
        <Pager page={page} pageSize={pageSize} total={total} onPage={onPage} />
      )}
    </>
  );
}
