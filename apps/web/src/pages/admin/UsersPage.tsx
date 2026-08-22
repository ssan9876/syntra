import { Alert, Empty, Field, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { CreatePanel } from './CreatePanel.js';
import { PageHeader } from './PageHeader.js';

interface UserRow {
  id: string;
  login: string;
  displayName: string;
  email: string;
  status: string;
  statusReason: string | null;
  /** Set when a directory source owns this account. Null means locally managed. */
  sourceId: string | null;
}

interface SourceRow {
  id: string;
  name: string;
}

export function UsersPage() {
  const { data, error, loading, reload } = useApiResource<{ users: UserRow[] }>(
    '/api/admin/users',
  );
  // For the org-unit picker on the create form. Same tolerance as the sources
  // read below: a caller without `directory.read` on units gets an empty list
  // and a form that still works, rather than a page that will not render.
  const { data: unitsData } = useApiResource<{ orgUnits: { id: string; name: string }[] }>(
    '/api/admin/org-units',
  );
  // Fetched alongside the users so a synced account can name the directory
  // that owns it, the way the sync run pages do. A caller holding
  // directory.read but not sync.read gets a 403 here; the hook turns that into
  // its own error state, which is deliberately ignored — a missing source name
  // is not a reason to fail the page, and the row still says the account is
  // managed elsewhere.
  const { data: sourcesData } = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/sources',
  );
  const sourceNames = new Map(
    (sourcesData?.sources ?? []).map((source) => [source.id, source.name]),
  );
  const anySynced = (data?.users ?? []).some((user) => Boolean(user.sourceId));

  return (
    <>
      <PageHeader
        title="Users"
        description="Accounts that can sign in. Employment details live under People."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <CreatePanel
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
              hint="How they sign in. Unique within this tenant."
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
              hint="Defaults to the login."
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
        // Said once, above the table, and again per row. An administrator who
        // edits the wrong account here would have their change overwritten by
        // the next run without explanation; the spec asks for synced fields to
        // read-only wherever they appear and to name the source that owns them.
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

          {!loading && data?.users.length === 0 && (
            <div className="p-6">
              <Empty title="No users yet">
                Users appear here once they are created, or once a directory
                synchronization brings them in.
              </Empty>
            </div>
          )}

          {!loading && data && data.users.length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Login</th>
                  <th scope="col" className="px-4 py-2.5 font-medium max-sm:hidden">
                    Email
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Managed by
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-border-subtle last:border-0 transition-colors hover:bg-surface"
                  >
                    <td className="px-4 py-2.5 font-medium text-ink">
                      {user.displayName}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{user.login}</td>
                    <td className="px-4 py-2.5 text-muted max-sm:hidden">
                      {user.email}
                    </td>
                    <td className="px-4 py-2.5">
                      {!user.sourceId ? (
                        <span className="text-muted">Syntra</span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-2">
                          {/* Named, not merely flagged: "synced" tells an
                              administrator nothing about where to go and
                              change it. The id stands in when the caller
                              cannot read the source list. */}
                          <Status tone="primary">
                            {sourceNames.get(user.sourceId) ?? 'Directory source'}
                          </Status>
                          <span className="text-sm text-muted">read-only</span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {/*
                        Inactive accounts stay listed and labelled. Hiding a
                        deactivation to keep the table tidy would make the
                        directory unauditable.
                      */}
                      {user.status === 'active' ? (
                        <Status tone="active">Active</Status>
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
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
