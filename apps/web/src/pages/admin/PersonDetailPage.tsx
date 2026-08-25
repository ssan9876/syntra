import { Link, useParams } from 'react-router-dom';
import { Alert, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
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
        description={
          data.externalId
            ? `Source reference ${data.externalId}`
            : 'No source reference recorded'
        }
      />

      <div className="space-y-6">
        <Panel
          title="Contracts"
          description="Every engagement this person holds, including concurrent ones."
        >
          {data.contracts.length === 0 ? (
            <div className="p-6">
              <Empty title="No contracts recorded">
                A contract records what someone does: their role, department,
                and the dates it runs between.
              </Empty>
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Role
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 font-medium max-sm:hidden"
                  >
                    Department
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    From
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Until
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.contracts.map((contract) => (
                  <tr
                    key={contract.id}
                    className="border-b border-border-subtle last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">
                          {contract.jobTitle ?? '—'}
                        </span>
                        {contract.isPrimary && (
                          <Status tone="primary">Primary</Status>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted max-sm:hidden">
                      {contract.department ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {day(contract.startDate)}
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {/* Open-ended is ongoing, not missing data. */}
                      {day(contract.endDate) ?? 'Ongoing'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                    hint="Business rules match on this, and the account's container in the directory is built from it."
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
                    hint="Leave empty for an open-ended engagement."
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
                    hint="Between 0 and 2. Rules can compare on it."
                    placeholder="1.0"
                  />
                </>
              )}
            />
          </div>
        </Panel>

        <Panel
          title="Accounts"
          description="The logins this person signs in with. One person may hold several."
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
            <p className="mt-1 text-muted">
              Every target-system account and entitlement, with the rule and the
              contract behind it.
            </p>
          </div>
        </Panel>

        <Link
          to="/admin/people"
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to people
        </Link>
      </div>
    </>
  );
}
