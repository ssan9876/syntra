import { Link } from 'react-router-dom';
import {
  Alert,
  Empty,
  Field,
  Panel,
  Select,
  SkeletonRows,
  Status,
  Table,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
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
  const { data, error, loading, reload } = useApiResource<{ users: UserRow[] }>(
    '/api/admin/users',
  );
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
  const sourceNames = new Map(
    (sourcesData?.sources ?? []).map((source) => [source.id, source.name]),
  );
  // Same narrowing as PeopleTab, and for the same reason: a 200 without its
  // collection must render an empty table, not a blank console.
  const users = data?.users ?? [];
  const anySynced = users.some((user) => Boolean(user.sourceId));

  return (
    <>
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
        })}
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
              label="Org unit"
              value={v.orgUnitId ?? ''}
              onChange={(x) => set('orgUnitId', x)}
              error={errs.orgUnitId}
              options={[
                { value: '', label: 'None' },
                ...(unitsData?.orgUnits ?? []).map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
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

          {!loading && users.length === 0 && (
            <div className="p-6">
              <Empty title="No users yet">
                Users appear here once they are created, or once a directory
                synchronization brings them in.
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
    </>
  );
}
