import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';
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

  /**
   * The accounts that could be linked: the ones belonging to NOBODY.
   *
   * `POST /persons/:id/link-user` existed and nothing called it, while the
   * empty state below told the reader to link an account and offered no
   * control that would. An account already attached to another person is not
   * a candidate -- offering it would invite a request the server refuses.
   */
  const { data: userList } = useApiResource<{
    users: { id: string; login: string; personId: string | null }[];
  }>('/api/admin/users');
  const candidates = (userList?.users ?? []).filter((user) => user.personId === null);

  const [linkTo, setLinkTo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const link = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/persons/${id}/link-user`, {
        method: 'POST',
        body: JSON.stringify({ userId: linkTo }),
      });
      setLinkTo('');
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That account could not be linked.',
      );
    } finally {
      setBusy(false);
    }
  };

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

          <div className="space-y-3 border-t border-border-subtle p-4">
            {problem && <Alert tone="warning">{problem}</Alert>}
            <Select
              label="Account to link"
              value={linkTo}
              onChange={setLinkTo}
              hint="Only accounts that belong to nobody yet."
              options={[
                { value: '', label: 'Choose an account…' },
                ...candidates.map((user) => ({ value: user.id, label: user.login })),
              ]}
            />
            <Button
              variant="primary"
              loading={busy}
              disabled={linkTo === ''}
              onClick={() => void link()}
            >
              Link
            </Button>
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
