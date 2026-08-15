import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface PersonRow {
  id: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
  externalId: string | null;
  status: string;
}

export function PersonsPage() {
  const { data, error, loading } = useApiResource<{ persons: PersonRow[] }>(
    '/api/admin/persons',
  );

  return (
    <>
      <PageHeader
        title="People"
        description="Who someone is, and the contracts they hold. Their sign-in accounts are listed under Users."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={6} cols={4} />}

          {!loading && data?.persons.length === 0 && (
            <div className="p-6">
              <Empty title="No people yet">
                Add someone directly, or import a file from your HR system on
                the Import page.
              </Empty>
            </div>
          )}

          {!loading && data && data.persons.length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Name
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 font-medium max-sm:hidden"
                  >
                    Email
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Reference
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.persons.map((person) => (
                  <tr
                    key={person.id}
                    className="border-b border-border-subtle transition-colors last:border-0 hover:bg-surface"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/admin/people/${person.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {person.givenName} {person.familyName}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-muted max-sm:hidden">
                      {person.businessEmail ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {person.externalId ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <Status
                        tone={person.status === 'active' ? 'active' : 'inactive'}
                      >
                        {person.status === 'active' ? 'Active' : 'Inactive'}
                      </Status>
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
