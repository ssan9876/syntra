import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
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
import { StatusToggle } from './StatusToggle.js';
import { SubjectLog } from './SubjectLog.js';
import { PageFacts, PageHeader } from './PageHeader.js';

interface Contract {
  id: string;
  sequence: number;
  isPrimary: boolean;
  startDate: string;
  endDate: string | null;
  jobTitle: string | null;
  department: string | null;
  /**
   * Not shown in the table, which has four columns and room for no more, but
   * carried so the edit form can round-trip them. A form that silently dropped
   * a cost centre it never displayed would be a correction that quietly
   * deleted data.
   */
  costCentre?: string | null;
  employer?: string | null;
  location?: string | null;
}

interface LinkedUser {
  id: string;
  login: string;
  status: string;
}

interface PersonDetail {
  id: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
  externalId: string | null;
  orgUnitId: string | null;
  status: string;
  contracts: Contract[];
  users: LinkedUser[];
}

const day = (iso: string | null) =>
  iso ? new Date(iso).toISOString().slice(0, 10) : null;

/**
 * One person: who they are, what they do, who can sign in as them, and what
 * has happened to them.
 *
 * Editing and deactivation used to live on the LIST and only there, which made
 * this -- the screen showing everything about somebody -- the one screen on
 * which nothing about them could be changed. Correcting a misspelt name meant
 * going back to a table and finding the row again.
 */
export function PersonDetailPage() {
  const { id } = useParams();
  const [editing, setEditing] = useState(false);
  /**
   * Which contract is being corrected, held as its sequence.
   *
   * One at a time and one panel above the table, the shape the accounts rework
   * settled on: a collapsed panel per row would put a block-level form inside
   * a table cell, and holding one piece of state per row is how the accounts
   * list ended up carrying six.
   */
  const [editingSequence, setEditingSequence] = useState<number | null>(null);
  const { data, error, loading, reload } = useApiResource<PersonDetail>(
    `/api/admin/persons/${id}`,
  );
  // Its error state is deliberately ignored, as on the users page: a caller
  // who may read people but not the directory gets an empty list and a
  // control that says it has nothing to offer, rather than a page that will
  // not render at all.
  const { data: usersData } = useApiResource<{
    users: { id: string; login: string; personId: string | null; status: string }[];
  }>('/api/admin/users');

  // Same treatment as the users list above: a caller who may not read the
  // directory gets an empty selector rather than a page that will not render.
  const { data: orgUnitsData } = useApiResource<{
    orgUnits: { id: string; name: string; status: string }[];
  }>('/api/admin/org-units');

  // An account already carrying a person is not offered. `link-user` would
  // move it rather than refuse, so listing one is offering to detach somebody
  // else's login by picking the wrong row.
  const unlinked = (usersData?.users ?? []).filter((u) => u.personId === null);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (loading || !data) {
    return (
      <Panel>
        <SkeletonRows rows={4} cols={4} />
      </Panel>
    );
  }

  return (
    <>
      <PageHeader
        title={`${data.givenName} ${data.familyName}`}
        actions={
          <>
            {!editing && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <StatusToggle
              active={data.status === 'active'}
              basePath={`/api/admin/persons/${data.id}`}
              label="person"
              consequences="Contracts end today. Sign-in accounts are not changed."
              onChanged={reload}
            />
          </>
        }
      />

      {/* The key an HR import matches this person on. It was in the header as
          a sentence — "Source reference E1001" — which is a label and a value
          written as prose. As a pair it is also selectable on its own, which
          is what somebody comparing it against a feed actually wants. */}
      <PageFacts
        facts={[
          {
            label: 'Status',
            value: (
              <Status tone={data.status === 'active' ? 'active' : 'inactive'}>
                {data.status === 'active' ? 'Active' : 'Inactive'}
              </Status>
            ),
          },
          {
            label: 'Business email',
            value: data.businessEmail ?? (
              <span className="font-normal text-muted">None recorded</span>
            ),
          },
          {
            label: 'Source reference',
            value: data.externalId ?? <span className="text-muted">None recorded</span>,
          },
        ]}
      />

      <div className="space-y-6">
        {editing && (
          <RecordPanel
            title={`Edit ${data.givenName} ${data.familyName}`}
            submitLabel="Save"
            method="PATCH"
            path={`/api/admin/persons/${data.id}`}
            initial={{
              givenName: data.givenName,
              familyName: data.familyName,
              businessEmail: data.businessEmail ?? '',
              externalId: data.externalId ?? '',
              orgUnitId: data.orgUnitId ?? '',
            }}
            onCancel={() => setEditing(false)}
            onCreated={() => {
              setEditing(false);
              reload();
            }}
            build={(v) => ({
              givenName: v.givenName ?? '',
              familyName: v.familyName ?? '',
              // NULL clears; omitting would mean "leave alone" and an emptied
              // box would keep the old value.
              businessEmail: v.businessEmail === '' ? null : (v.businessEmail ?? null),
              externalId: v.externalId === '' ? null : (v.externalId ?? null),
              // NULL sends them back to the account profile's template. As
              // above, omitting would mean "leave alone" and an emptied
              // selector would keep the old unit.
              orgUnitId: v.orgUnitId === '' ? null : (v.orgUnitId ?? null),
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
                <Select
                  label="Org unit"
                  value={v.orgUnitId ?? ''}
                  onChange={(x) => set('orgUnitId', x)}
                  error={errs.orgUnitId}
                  options={[
                    { value: '', label: 'None — placed by the account profile' },
                    ...(orgUnitsData?.orgUnits ?? [])
                      // A deactivated unit grants nothing and is not somewhere
                      // to put anybody new.
                      .filter((u) => u.status === 'active')
                      .map((u) => ({ value: u.id, label: u.name })),
                  ]}
                />
                <Field
                  label="Source reference"
                  value={v.externalId ?? ''}
                  onChange={(x) => set('externalId', x)}
                  error={errs.externalId}
                  warning={
                    // Shown only when there is already a value to change. On a
                    // person with no reference there is nothing to break yet,
                    // and a warning about breaking it would be a hint by
                    // another name.
                    data.externalId
                      ? 'Changing this makes the next import create a second person rather than update this one.'
                      : undefined
                  }
                />
              </>
            )}
          />
        )}

        {editingSequence !== null &&
          (() => {
            const target = data.contracts.find(
              (c) => c.sequence === editingSequence,
            );
            // Gone from under the form — reloaded after somebody else removed
            // it. Rendering nothing beats rendering a form that would PATCH a
            // sequence this person no longer holds.
            if (!target) return null;
            return (
              <RecordPanel
                title={`Edit contract ${target.sequence}`}
                submitLabel="Save"
                method="PATCH"
                path={`/api/admin/persons/${data.id}/contracts/${target.sequence}`}
                initial={{
                  jobTitle: target.jobTitle ?? '',
                  department: target.department ?? '',
                  costCentre: target.costCentre ?? '',
                  employer: target.employer ?? '',
                  location: target.location ?? '',
                  endDate: day(target.endDate) ?? '',
                }}
                onCancel={() => setEditingSequence(null)}
                onCreated={() => {
                  setEditingSequence(null);
                  reload();
                }}
                // An emptied box CLEARS the field rather than being dropped.
                // This is an edit form: the difference between "leave it" and
                // "there is no department" is the whole reason the schema
                // takes a null, and dropping the empty string would make a
                // field uncorrectable in the direction of removing it.
                build={(v) => ({
                  jobTitle: v.jobTitle?.trim() ? v.jobTitle : null,
                  department: v.department?.trim() ? v.department : null,
                  costCentre: v.costCentre?.trim() ? v.costCentre : null,
                  employer: v.employer?.trim() ? v.employer : null,
                  location: v.location?.trim() ? v.location : null,
                  endDate: v.endDate?.trim() ? v.endDate : null,
                })}
                fields={(v, set, errs) => (
                  <>
                    <Field
                      label="Job title"
                      value={v.jobTitle ?? ''}
                      onChange={(x) => set('jobTitle', x)}
                      error={errs.jobTitle}
                    />
                    <Field
                      label="Department"
                      value={v.department ?? ''}
                      onChange={(x) => set('department', x)}
                      error={errs.department}
                    />
                    <Field
                      label="Cost centre"
                      value={v.costCentre ?? ''}
                      onChange={(x) => set('costCentre', x)}
                      error={errs.costCentre}
                    />
                    <Field
                      label="Employer"
                      value={v.employer ?? ''}
                      onChange={(x) => set('employer', x)}
                      error={errs.employer}
                    />
                    <Field
                      label="Location"
                      value={v.location ?? ''}
                      onChange={(x) => set('location', x)}
                      error={errs.location}
                    />
                    <Field
                      label="End date"
                      type="date"
                      value={v.endDate ?? ''}
                      onChange={(x) => set('endDate', x)}
                      error={errs.endDate}
                    />
                  </>
                )}
              />
            );
          })()}

        {/* `isPrimary` is deliberately absent from that form. Promoting a
            contract is a different decision from correcting one — the API
            supports it, and a checkbox for it beside a typo fix is how
            somebody demotes a primary contract while fixing a department. */}

        <Panel
          title="Contracts"
        >
          {data.contracts.length === 0 ? (
            <div className="p-6">
              <Empty title="No contracts recorded">
                A contract records what someone does: their role, department,
                and the dates it runs between.
              </Empty>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th scope="col">
                    Role
                  </th>
                  <th
                    scope="col"
                    className="max-sm:hidden"
                  >
                    Department
                  </th>
                  <th scope="col">
                    From
                  </th>
                  <th scope="col">
                    Until
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.contracts.map((contract) => (
                  <tr key={contract.id}>
                    <td>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">
                          {contract.jobTitle ?? '—'}
                        </span>
                        {contract.isPrimary && (
                          <Status tone="primary">Primary</Status>
                        )}
                      </span>
                    </td>
                    <td className="max-sm:hidden">
                      {contract.department ?? '—'}
                    </td>
                    <td>
                      {day(contract.startDate)}
                    </td>
                    <td>
                      {/* Open-ended is ongoing, not missing data. */}
                      {day(contract.endDate) ?? 'Ongoing'}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditingSequence(contract.sequence)}
                      >
                        {/* Named with its sequence rather than a bare "Edit":
                            a column of identical buttons is announced one
                            after another with no way to tell the rows
                            apart. */}
                        Edit contract {contract.sequence}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {/* The endpoint has existed since Identity and nothing called it, so
              a contract could only ever arrive by CSV import or a directory
              sync. That is not a cosmetic gap: `desiredState` reads contracts
              to decide anybody should hold an account at all, so a person
              created by hand had nothing for the planner to act on and
              provisioned nothing. */}
          <div className="border-t border-border-subtle p-4">
            <RecordPanel
              title="Add contract"
              submitLabel="Add contract"
              path={`/api/admin/persons/${data.id}/contracts`}
              onCreated={reload}
              build={(v) => ({
                // One past the highest. A duplicate sequence is a 409, and
                // counting the rows instead would reuse a number after a
                // contract in the middle was removed.
                sequence:
                  Math.max(0, ...data.contracts.map((c) => c.sequence)) + 1,
                // Primary only when nothing else is: the partial unique index
                // allows exactly one, and a second is refused as a conflict.
                isPrimary: !data.contracts.some((c) => c.isPrimary),
                startDate: v.startDate ?? '',
                ...(v.endDate ? { endDate: v.endDate } : {}),
                ...(v.jobTitle ? { jobTitle: v.jobTitle } : {}),
                ...(v.department ? { department: v.department } : {}),
                ...(v.costCentre ? { costCentre: v.costCentre } : {}),
                ...(v.employer ? { employer: v.employer } : {}),
                ...(v.location ? { location: v.location } : {}),
                ...(v.fte ? { fte: Number(v.fte) } : {}),
              })}
              fields={(v, set, errs) => (
                <>
                  <Field
                    label="Job title"
                    value={v.jobTitle ?? ''}
                    onChange={(x) => set('jobTitle', x)}
                    error={errs.jobTitle}
                    placeholder="Staff Nurse"
                  />
                  <Field
                    label="Department"
                    value={v.department ?? ''}
                    onChange={(x) => set('department', x)}
                    error={errs.department}
                    placeholder="Nursing"
                  />
                  <Field
                    label="Start date"
                    type="date"
                    value={v.startDate ?? ''}
                    onChange={(x) => set('startDate', x)}
                    error={errs.startDate}
                  />
                  <Field
                    label="End date"
                    type="date"
                    value={v.endDate ?? ''}
                    onChange={(x) => set('endDate', x)}
                    error={errs.endDate}
                  />
                  <Field
                    label="Cost centre"
                    value={v.costCentre ?? ''}
                    onChange={(x) => set('costCentre', x)}
                    error={errs.costCentre}
                  />
                  <Field
                    label="Employer"
                    value={v.employer ?? ''}
                    onChange={(x) => set('employer', x)}
                    error={errs.employer}
                  />
                  <Field
                    label="Location"
                    value={v.location ?? ''}
                    onChange={(x) => set('location', x)}
                    error={errs.location}
                  />
                  <Field
                    label="FTE"
                    value={v.fte ?? ''}
                    onChange={(x) => set('fte', x)}
                    error={errs.fte}
                    placeholder="1.0"
                  />
                </>
              )}
            />
          </div>
        </Panel>

        <Panel
          title="Accounts"
        >
          {data.users.length === 0 ? (
            <div className="p-6">
              <Empty title="No accounts linked">
                This person exists in the directory but cannot sign in. Link an
                account to give them access.
              </Empty>
            </div>
          ) : (
            <ul>
              {data.users.map((user) => (
                <li
                  key={user.id}
                  className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 last:border-0"
                >
                  {/* The way in to the account, which had none. An account
                      named here and not linked left the reader to find it
                      again in a table on another tab. */}
                  <Link
                    to={`/admin/users/${user.id}`}
                    className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                  >
                    {user.login}
                  </Link>
                  <Status
                    tone={user.status === 'active' ? 'active' : 'inactive'}
                  >
                    {user.status === 'active' ? 'Active' : 'Inactive'}
                  </Status>
                </li>
              ))}
            </ul>
          )}

          {/* The other endpoint nothing called. The empty state above has
              always advised linking an account and offered no way to do it,
              so an account created here stayed an orphan for good: no person,
              therefore no contracts, therefore nothing the planner reads. */}
          <div className="border-t border-border-subtle p-4">
            <RecordPanel
              title="Link an account"
              submitLabel="Link an account"
              path={`/api/admin/persons/${data.id}/link-user`}
              onCreated={reload}
              disabled={unlinked.length === 0}
              disabledReason="Every account already belongs to somebody."
              build={(v) => ({ userId: v.userId ?? '' })}
              fields={(v, set, errs) => (
                <Select
                  label="Account"
                  value={v.userId ?? ''}
                  onChange={(x) => set('userId', x)}
                  error={errs.userId}
                  options={[
                    { value: '', label: 'Choose an account' },
                    ...unlinked.map((u) => ({ value: u.id, label: u.login })),
                  ]}
                />
              )}
            />
          </div>
        </Panel>

        {/*
          The person AND every account linked to them. A person's own record
          collects the joiner and mover events; the sign-ins, lockouts and
          password resets are all against their accounts, and asking only about
          the person id would hide most of what there is to see.
        */}
        <SubjectLog subjects={[data.id, ...data.users.map((u) => u.id)]} />

        {/* The one question every auditor asks, and it has to be reachable
            from the person rather than only by typing a URL. */}
        <Panel title="Access">
          <div className="p-4">
            <Link
              to={`/admin/people/${data.id}/access`}
              className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
            >
              Why does this person hold what they hold?
            </Link>
          </div>
        </Panel>

        <Link
          to="/admin/users?tab=people"
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to people
        </Link>
      </div>
    </>
  );
}
