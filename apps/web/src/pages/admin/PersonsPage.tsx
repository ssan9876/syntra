import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Empty,
  Field,
  Panel,
  SkeletonRows,
  Status,
  Table,
  buttonClasses,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
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
  // ONE editor for the page, opened by a row. See the same note on UsersPage.
  const [editing, setEditing] = useState<PersonRow | null>(null);

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone the organization knows, and the contracts they hold. Start here to onboard somebody; their sign-in accounts are listed under Users."
        actions={
          <Link to="/admin/people/new" className={buttonClasses('primary')}>
            Add someone
          </Link>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {editing && (
        <RecordPanel
          key={editing.id}
          title={`Edit ${editing.givenName} ${editing.familyName}`}
          submitLabel="Save"
          method="PATCH"
          path={`/api/admin/persons/${editing.id}`}
          initial={{
            givenName: editing.givenName,
            familyName: editing.familyName,
            businessEmail: editing.businessEmail ?? '',
            externalId: editing.externalId ?? '',
          }}
          onCancel={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
            reload();
          }}
          build={(v) => ({
            givenName: v.givenName ?? '',
            familyName: v.familyName ?? '',
            // NULL clears; omitting would mean "leave alone" and an emptied
            // box would keep the old value.
            businessEmail: v.businessEmail === '' ? null : (v.businessEmail ?? null),
            externalId: v.externalId === '' ? null : (v.externalId ?? null),
          })}
          fields={(v, set, errs) => (
            <>
              <Field
                label="Given name"
                value={v.givenName ?? ''}
                onChange={(x) => set('givenName', x)}
                error={errs.givenName}
              />
              <Field
                label="Family name"
                value={v.familyName ?? ''}
                onChange={(x) => set('familyName', x)}
                error={errs.familyName}
              />
              <Field
                label="Business email"
                type="email"
                value={v.businessEmail ?? ''}
                onChange={(x) => set('businessEmail', x)}
                error={errs.businessEmail}
              />
              <Field
                label="External id"
                value={v.externalId ?? ''}
                onChange={(x) => set('externalId', x)}
                error={errs.externalId}
                hint="The key a CSV import matches on. Changing it makes the next import create a second person rather than update this one."
              />
            </>
          )}
        />
      )}

      {/* The create form has moved to /admin/people/new.
          A four-field panel here recorded WHO somebody is and stopped, which
          read as the whole job and was not: the contract that makes them
          provisionable, and the login that lets them sign in, had no form
          anywhere. Sending the primary action to a page that asks for all
          three is what closes that, and it is why this page keeps a list and
          nothing else. */}

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
            <Table>
              <thead>
                <tr>
                  <th scope="col">
                    Name
                  </th>
                  <th
                    scope="col"
                    className="max-sm:hidden"
                  >
                    Email
                  </th>
                  <th scope="col">
                    Reference
                  </th>
                  <th scope="col">
                    Status
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.persons.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <Link
                        to={`/admin/people/${person.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {person.givenName} {person.familyName}
                      </Link>
                    </td>
                    <td className="max-sm:hidden">
                      {person.businessEmail ?? '—'}
                    </td>
                    <td>
                      {person.externalId ?? '—'}
                    </td>
                    <td>
                      <Status
                        tone={person.status === 'active' ? 'active' : 'inactive'}
                      >
                        {person.status === 'active' ? 'Active' : 'Inactive'}
                      </Status>
                    </td>
                    <td className="text-right">
                      <span className="mr-2 inline-block align-middle">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setEditing(person)}
                        >
                          Edit
                        </Button>
                      </span>
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
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
