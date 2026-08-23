import { Link } from 'react-router-dom';
import { Alert, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { CreatePanel } from './CreatePanel.js';
import { StatusToggle } from './StatusToggle.js';
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
  const { data, error, loading, reload } = useApiResource<{ persons: PersonRow[] }>(
    '/api/admin/persons',
  );

  return (
    <>
      <PageHeader
        title="People"
        description="Who someone is, and the contracts they hold. Their sign-in accounts are listed under Users."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <CreatePanel
        title="New person"
        submitLabel="Add someone"
        path="/api/admin/persons"
        onCreated={reload}
        build={(v) => ({
          givenName: v.givenName ?? '',
          familyName: v.familyName ?? '',
          // Each omitted when blank. The schema validates these as e-mail
          // addresses and as a bounded string, and '' satisfies neither.
          ...(v.businessEmail ? { businessEmail: v.businessEmail } : {}),
          ...(v.externalId ? { externalId: v.externalId } : {}),
        })}
        fields={(v, set, errs) => (
          <>
            <Field
              label="Given name"
              value={v.givenName ?? ''}
              onChange={(x) => set('givenName', x)}
              error={errs.givenName}
              placeholder="Maya"
            />
            <Field
              label="Family name"
              value={v.familyName ?? ''}
              onChange={(x) => set('familyName', x)}
              error={errs.familyName}
              placeholder="Okafor"
            />
            <Field
              label="Business email"
              value={v.businessEmail ?? ''}
              onChange={(x) => set('businessEmail', x)}
              error={errs.businessEmail}
              type="email"
              placeholder="maya.okafor@acme.localhost"
            />
            <Field
              label="External id"
              value={v.externalId ?? ''}
              onChange={(x) => set('externalId', x)}
              error={errs.externalId}
              hint="The identifier the HR system knows them by. Must be unique."
              placeholder="E1042"
            />
          </>
        )}
      />

      {/* A person is not an account. Creating one here records WHO somebody
          is; linking them to a login, and giving them a contract, are separate
          acts on their own page — which is the distinction this product is
          built on and the reason the two lists are not one list. */}

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
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    <span className="sr-only">Actions</span>
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
                    <td className="px-4 py-2.5 text-right">
                      <StatusToggle
                        active={person.status === 'active'}
                        basePath={`/api/admin/persons/${person.id}`}
                        label="person"
                        reasonPrompt="Why is this person being deactivated? Their sign-in accounts are NOT changed by this — deactivate those separately."
                        onChanged={reload}
                      />
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
