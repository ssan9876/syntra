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
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PickerNote } from './PickerNote.js';
import { RecordPanel } from './RecordPanel.js';
import { StatusToggle } from './StatusToggle.js';
import { SubjectLog } from './SubjectLog.js';
import { PageFacts, PageHeader } from './PageHeader.js';

interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  statusReason: string | null;
  /** Set when a directory source owns this group. Null means locally managed. */
  sourceId: string | null;
}

interface MemberRow {
  id: string;
  login: string;
  displayName: string;
  status: string;
}

/**
 * One group: what it is, who is in it, and its history.
 *
 * Membership is the thing a group is FOR, and it lived in a panel opened from
 * a row of the list — which meant the list held four pieces of state that were
 * each only ever about ONE group, and fetched every account in the tenant to
 * fill a picker whether or not anybody opened it. Here the account list is
 * read because the reader is looking at the group whose members it is for.
 *
 * There is no delete. Groups have no delete route, deliberately: deactivating
 * keeps the members and grants nothing, which is the answer for a group that
 * has stopped being used.
 */
export function GroupDetailPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApiResource<GroupDetail>(
    `/api/admin/groups/${id}`,
  );
  // Its error state is deliberately ignored, as on the account record: a
  // caller who may read the directory but not its sources gets a group that
  // still renders and simply cannot name the directory that owns it.
  const { data: sourcesData } = useApiResource<{
    sources: { id: string; name: string }[];
  }>('/api/admin/sources');

  const { data: memberData, reload: reloadMembers } = useApiResource<{
    users: MemberRow[];
  }>(`/api/admin/groups/${id}/members`);

  /**
   * The accounts that can be added.
   *
   * Its failure is READ rather than ignored. `directory.read` gates this list
   * and a caller can administer groups without holding it, so swallowing the
   * error renders an empty picker that reads as "there is nobody left to add"
   * — a false statement about the tenant, where the truth is a right the
   * reader does not hold. The roles screen names the same refusal the same
   * way, on purpose.
   */
  const { data: accountData, error: accountsError } = useApiResource<{
    users: { id: string; login: string; displayName: string }[];
    total: number;
  }>('/api/admin/users?pageSize=200');

  const [editing, setEditing] = useState(false);
  const [addUserId, setAddUserId] = useState('');
  const [memberProblem, setMemberProblem] = useState<string | null>(null);

  const changeMembership = async (userId: string, method: 'POST' | 'DELETE') => {
    setMemberProblem(null);
    try {
      await api(`/api/admin/groups/${id}/members/${userId}`, { method });
      setAddUserId('');
      reloadMembers();
    } catch (cause) {
      // Surfaced rather than swallowed: a membership change that quietly did
      // nothing sends the administrator away believing it took.
      setMemberProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That membership could not be changed.',
      );
    }
  };

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (loading || !data) {
    return (
      <Panel>
        <SkeletonRows rows={4} cols={3} />
      </Panel>
    );
  }

  const local = data.sourceId === null;
  const source = data.sourceId
    ? (sourcesData?.sources ?? []).find((s) => s.id === data.sourceId)
    : null;
  const members = memberData?.users ?? [];
  const memberIds = new Set(members.map((m) => m.id));
  const candidates = (accountData?.users ?? []).filter((u) => !memberIds.has(u.id));

  return (
    <>
      <PageHeader
        title={data.name}
        actions={
          // Only for a locally managed group. A directory owns the name and
          // description of a group it syncs and rewrites them on every run, so
          // this form would offer a change that silently reverts.
          local && !editing ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : undefined
        }
      />

      <PageFacts
        facts={[
          {
            label: 'Description',
            value: data.description ? (
              data.description
            ) : (
              <span className="font-normal text-muted">None</span>
            ),
          },
          {
            label: 'Status',
            value:
              data.status === 'active' ? (
                <Status tone="active">Active</Status>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Status tone="inactive">Inactive</Status>
                  {data.statusReason && (
                    <span className="font-normal text-muted">
                      {data.statusReason}
                    </span>
                  )}
                </span>
              ),
          },
          {
            label: 'Managed by',
            value: local ? (
              <span className="text-muted">Syntra</span>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <Status tone="primary">{source?.name ?? 'Directory source'}</Status>
                <span className="font-normal text-muted">read-only</span>
              </span>
            ),
          },
        ]}
      />

      <div className="space-y-6">
        {editing && (
          <RecordPanel
            title={`Edit ${data.name}`}
            submitLabel="Save"
            method="PATCH"
            path={`/api/admin/groups/${data.id}`}
            initial={{ name: data.name, description: data.description ?? '' }}
            onCancel={() => setEditing(false)}
            onCreated={() => {
              setEditing(false);
              reload();
            }}
            build={(v) => ({
              name: v.name ?? '',
              // NULL, not omitted. Omitting means "leave alone" in a PATCH, so
              // an emptied box would silently keep the old description.
              description: v.description === '' ? null : (v.description ?? null),
            })}
            fields={(v, set, errs) => (
              <>
                <Field
                  label="Name"
                  value={v.name ?? ''}
                  onChange={(x) => set('name', x)}
                  error={errs.name}
                />
                <Field
                  label="Description"
                  value={v.description ?? ''}
                  onChange={(x) => set('description', x)}
                  error={errs.description}
                />
              </>
            )}
          />
        )}

        <Panel title="Members">
          <div className="space-y-4">
            {memberProblem && (
              <div className="px-4 pt-4">
                <Alert tone="warning">{memberProblem}</Alert>
              </div>
            )}

            {members.length === 0 ? (
              <div className="p-6">
                <Empty title="Nobody is in this group">
                  Add an account below. The group grants its applications to
                  everybody in it.
                </Empty>
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Login</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr key={member.id}>
                      <td>
                        <Link
                          to={`/admin/users/${member.id}`}
                          className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                        >
                          {member.displayName}
                        </Link>
                      </td>
                      <td className="font-mono text-sm">{member.login}</td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void changeMembership(member.id, 'DELETE')}
                        >
                          Remove from group
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            <div className="space-y-3 border-t border-border-subtle p-4">
              {accountsError ? (
                // Named, not merely absent. The reader cannot grant themselves
                // `directory.read`, and they cannot ask somebody for a right
                // they cannot name either. An empty picker instead would say
                // there is nobody left to add, which is not true.
                <p className="text-sm text-muted">
                  Adding a member needs directory.read, which this account does not
                  hold.
                </p>
              ) : (
                <>
                  <Select
                    label="Add a member"
                    value={addUserId}
                    onChange={setAddUserId}
                    options={[
                      { value: '', label: 'Choose an account…' },
                      ...candidates.map((candidate) => ({
                        value: candidate.id,
                        label: `${candidate.displayName} — ${candidate.login}`,
                      })),
                    ]}
                  />
                  <PickerNote
                    shown={accountData?.users?.length ?? 0}
                    total={accountData?.total ?? 0}
                    to="/admin/users?tab=accounts"
                    label="Accounts"
                  />
                  <Button
                    variant="primary"
                    disabled={addUserId === ''}
                    onClick={() => void changeMembership(addUserId, 'POST')}
                  >
                    Add
                  </Button>
                </>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="Status">
          <div className="p-4">
            <div className="min-w-[16rem] max-w-md">
              {local ? (
                <StatusToggle
                  active={data.status === 'active'}
                  basePath={`/api/admin/groups/${data.id}`}
                  label="group"
                  consequences="Members are kept. The group grants nothing."
                  onChanged={reload}
                />
              ) : (
                // The next sync run reads the group out of the directory and
                // puts its status back, so the control is not offered rather
                // than offered and quietly undone.
                <span className="text-sm text-muted">
                  {source?.name ?? 'A directory source'} owns this group, and the
                  next sync run would put it back
                </span>
              )}
            </div>
          </div>
        </Panel>

        <SubjectLog subjects={[data.id]} />

        <Link
          to="/admin/groups"
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to groups
        </Link>
      </div>
    </>
  );
}
