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

interface PersonRow {
  id: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
  externalId: string | null;
  status: string;
}

export function PeopleTab() {
  const { data, error, loading, reload } = useApiResource<{ persons: PersonRow[] }>(
    '/api/admin/persons',
  );
  // ONE editor for the page, opened by a row. See the same note on UsersPage.
  const [editing, setEditing] = useState<PersonRow | null>(null);
  // Narrowed once, here, rather than `data?.persons.length` at each use.
  // The optional chain guards `data` and then walks straight into `.persons`,
  // so a 200 that arrives without its collection throws inside render and
  // takes the whole console to a blank page instead of showing an empty
  // table. Found when the merged Users screen was asked what it does with a
  // truncated response.
  const persons = data?.persons ?? [];

  return (
    <>
      {/* The action lives with the table it acts on, not in the page header.
          One header above three tabs would need a word saying which tab its
          button applied to, and that word is the thing this redesign is
          removing. */}
      <div className="mb-4 flex justify-end">
        <Link to="/admin/people/new" className={buttonClasses('primary')}>
          Add someone
        </Link>
      </div>

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
                warning={
                  // Shown only when there is already a value to change. On a
                  // new person there is nothing to break yet, and a warning
                  // about breaking it would be a hint by another name.
                  editing.externalId
                    ? 'Changing this makes the next import create a second person rather than update this one.'
                    : undefined
                }
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

          {!loading && persons.length === 0 && (
            <div className="p-6">
              {/* An action, not a sentence. The old copy said "Add someone
                  directly, or import a file from your HR system on the Import
                  page" — a sentence whose second half was navigation
                  instructions to a screen that is now a tab beside this one.
                  A button does the first half and the tab strip does the
                  second. */}
              <Empty
                title="No people yet"
                action={
                  <Link to="/admin/people/new" className={buttonClasses('primary')}>
                    Add someone
                  </Link>
                }
              />
            </div>
          )}

          {!loading && persons.length > 0 && (
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
                {persons.map((person) => (
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
                        consequences="Contracts end today. Sign-in accounts are not changed."
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
