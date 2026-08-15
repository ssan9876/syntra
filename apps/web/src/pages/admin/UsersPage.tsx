import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface UserRow {
  id: string;
  login: string;
  displayName: string;
  email: string;
  status: string;
  statusReason: string | null;
}

export function UsersPage() {
  const { data, error, loading } = useApiResource<{ users: UserRow[] }>(
    '/api/admin/users',
  );

  return (
    <>
      <PageHeader
        title="Users"
        description="Accounts that can sign in. Employment details live under People."
      />

      {error && <Alert tone="danger">{error}</Alert>}

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
