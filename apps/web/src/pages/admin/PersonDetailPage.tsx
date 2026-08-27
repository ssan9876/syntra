import { Link, useParams } from 'react-router-dom';
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
import { PageHeader } from './PageHeader.js';

interface Contract {
  id: string;
  sequence: number;
  isPrimary: boolean;
  startDate: string;
  endDate: string | null;
  jobTitle: string | null;
  department: string | null;
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
  status: string;
  contracts: Contract[];
  users: LinkedUser[];
}

const day = (iso: string | null) =>
  iso ? new Date(iso).toISOString().slice(0, 10) : null;

export function PersonDetailPage() {
  const { id } = useParams();
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
      />

      <div className="space-y-6">
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
                  <span className="font-medium text-ink">{user.login}</span>
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
