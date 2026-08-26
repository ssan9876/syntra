import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
import { DeleteButton } from './DeleteButton.js';
import { StatusToggle } from './StatusToggle.js';
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
  /**
   * Where the password lives: 'local' means Syntra holds the hash, 'upstream'
   * means an external provider does.
   *
   * Optional here rather than required, because the guard below reads it as
   * "not upstream" rather than "is local". The server is the authority and
   * answers 409 for a user it cannot set a password for; a UI guard that
   * silently hid the button on an unrecognised value would leave an
   * administrator with no control and no explanation.
   */
  passwordSource?: string;
}

interface SourceRow {
  id: string;
  name: string;
  /**
   * Whether Syntra may disable an account in this directory. Both are needed:
   * `writebackEnabled` is the master switch and `writebackDisable` the
   * individual permission, and the server checks the same pair.
   */
  writebackEnabled: boolean;
  writebackDisable: boolean;
}

export function UsersPage() {
  const can = useCan();
  const { data, error, loading, reload } = useApiResource<{ users: UserRow[] }>(
    '/api/admin/users',
  );
  // ONE editor for the page, opened by a row — not one collapsed panel per
  // row, which would put a block-level trigger and a two-column form inside a
  // table cell.
  const [editing, setEditing] = useState<UserRow | null>(null);
  // One at a time, like the editor above: a setup link is a credential, and a
  // page holding several of them at once invites pasting the wrong one.
  const [setupLink, setSetupLink] = useState<{
    login: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
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
  // Which sources Syntra may disable an account in. A caller who cannot read
  // sources gets an empty set and therefore no buttons, which is the right way
  // round: the server would refuse the write anyway, and offering a control
  // that always fails is worse than not offering it.
  const writesDisable = new Set(
    (sourcesData?.sources ?? [])
      .filter((source) => source.writebackEnabled && source.writebackDisable)
      .map((source) => source.id),
  );
  const anySynced = (data?.users ?? []).some((user) => Boolean(user.sourceId));

  return (
    <>
      {/* Not a duplicate of People, and the description is what says so.
          The two pages read as two lists of the same thing for as long as
          this one sat in the onboarding path, which it never belonged in:
          where a directory source owns the accounts, a joiner's login arrives
          here by sync rather than by anybody typing it. */}
      <PageHeader
        title="Users"
        description="Accounts that sign into Syntra. Most arrive automatically from a directory sync — create one here only for an administrator, or somebody with no directory presence. To onboard a new joiner, start under People."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {linkError && <Alert tone="danger">{linkError}</Alert>}

      {setupLink && (
        <Panel>
          <h2 className="font-medium text-ink">
            Password setup link for {setupLink.login}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Send this to them. It can be used once, expires{' '}
            {new Date(setupLink.expiresAt).toLocaleString()}, and generating
            another one stops the previous link working.
          </p>
          {/*
            A read-only input, not an anchor. An administrator who clicks a
            link to check it has spent the token, and the joiner they send it
            to gets a dead page.
          */}
          <input
            readOnly
            aria-label="Password setup link"
            value={setupLink.url}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-3 w-full rounded border border-line bg-surface px-3 py-2 font-mono text-sm"
          />
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              onClick={() => navigator.clipboard?.writeText(setupLink.url)}
            >
              Copy
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setSetupLink(null)}>
              Done
            </Button>
          </div>
        </Panel>
      )}

      {editing && (
        <RecordPanel
          key={editing.id}
          title={`Edit ${editing.login}`}
          submitLabel="Save"
          method="PATCH"
          path={`/api/admin/users/${editing.id}/details`}
          initial={{ displayName: editing.displayName, email: editing.email }}
          onCancel={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
            reload();
          }}
          build={(v) => ({
            displayName: v.displayName ?? '',
            email: v.email ?? '',
          })}
          fields={(v, set, errs) => (
            <>
              <Field
                label="Display name"
                value={v.displayName ?? ''}
                onChange={(x) => set('displayName', x)}
                error={errs.displayName}
              />
              <Field
                label="Email"
                type="email"
                value={v.email ?? ''}
                onChange={(x) => set('email', x)}
                error={errs.email}
                hint="The login name is not editable — it is what people sign in with and what the audit trail is read by."
              />
            </>
          )}
        />
      )}

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
                    <td className="px-4 py-2.5 text-right">
                      {user.sourceId === null && (
                        <span className="mr-2 inline-block align-middle">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setEditing(user)}
                          >
                            Edit
                          </Button>
                        </span>
                      )}
                      {/*
                        Offered for a synced account as well as a local one:
                        a directory-owned user still authenticates against
                        Syntra's own hash, so they need this exactly as much.
                        It is the federated user, whose password lives
                        somewhere else entirely, who cannot use it.
                      */}
                      {user.passwordSource !== 'upstream' && (
                        <span className="mr-2 inline-block align-middle">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={async () => {
                              setLinkError(null);
                              const res = await fetch(
                                `/api/admin/users/${user.id}/password-setup`,
                                { method: 'POST' },
                              );
                              if (!res.ok) {
                                const problem = await res.json().catch(() => ({}));
                                setLinkError(
                                  problem.detail ??
                                    problem.title ??
                                    'Could not create a setup link.',
                                );
                                return;
                              }
                              const body = await res.json();
                              setSetupLink({
                                login: user.login,
                                url: body.url,
                                expiresAt: body.expiresAt,
                              });
                            }}
                          >
                            Password link
                          </Button>
                        </span>
                      )}
                      {user.sourceId === null || writesDisable.has(user.sourceId) ? (
                        // A source-owned account used to be refused here, and
                        // the refusal was honest: the next run read it as
                        // present in the directory and proposed reactivating
                        // it, so the button would have undone itself. It works
                        // now because the deactivation is written THROUGH to
                        // the directory and sync no longer resurrects an
                        // account the source reports disabled.
                        <StatusToggle
                          active={user.status === 'active'}
                          basePath={`/api/admin/users/${user.id}`}
                          label="user"
                          reasonPrompt={
                            user.sourceId === null
                              ? 'Why is this account being deactivated? Every session and refresh token is revoked immediately.'
                              : // Says what actually happens, in order. A
                                // confirmation that asks "are you sure?"
                                // without saying what follows is one people
                                // click through without reading.
                                `Why is this account being deactivated? The account is disabled in ${
                                  sourceNames.get(user.sourceId) ?? 'the directory'
                                } immediately, every session is revoked, and the leaver steps configured on the target follow from today.`
                          }
                          onChanged={reload}
                        />
                      ) : (
                        // Write-back is off for this source, so a status
                        // changed here would be undone by the next run. Naming
                        // the source and the setting is the difference between
                        // a dead end and something an administrator can act
                        // on.
                        <span className="text-sm text-muted">
                          {sourceNames.get(user.sourceId) ?? 'A directory source'}{' '}
                          owns this account, and write-back is off
                        </span>
                      )}
                      {/* Offered second, and only to a caller holding the
                          separate permission. Deactivation is the answer for
                          a leaver; this is for an account that should stop
                          existing, and the server refuses it anyway for a
                          source not configured to allow it. */}
                      {can('directory.delete') && (
                        <span className="mt-2 block">
                          <DeleteButton
                            path={`/api/admin/users/${user.id}`}
                            label="user"
                            confirmWord={user.login}
                            warning="The account is removed from the directory and from Syntra, and every session with it. The person and the audit trail are kept. This cannot be undone."
                            onDeleted={reload}
                          />
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
