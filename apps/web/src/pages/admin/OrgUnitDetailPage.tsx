import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
import { DeleteButton } from './DeleteButton.js';
import { StatusToggle } from './StatusToggle.js';
import { ContainersPanel } from './ContainersPanel.js';
import { SubjectLog } from './SubjectLog.js';
import { PageFacts, PageHeader } from './PageHeader.js';

interface OrgUnitDetail {
  id: string;
  name: string;
  parentId: string | null;
  status: string;
  statusReason: string | null;
  /** Set when a directory source owns this unit. Null means locally managed. */
  sourceId: string | null;
  /** Named rather than referenced: an id is not something a reader can follow. */
  parent: { id: string; name: string } | null;
  users: { id: string; login: string; displayName: string; status: string }[];
  children: { id: string; name: string; status: string }[];
}

/**
 * One organizational unit: where it sits, what is inside it, and its history.
 *
 * The tree carried every control on its rows — edit, deactivate, delete — so
 * clicking a unit did nothing, and the two questions a unit actually raises
 * could not be asked of it at all: who is sitting in this, and what is beneath
 * it. Both are the emptiness rule that refuses a delete, which meant the rule
 * only ever arrived as a 409 AFTER the reader had typed the unit's name to
 * confirm.
 *
 * A node in a tree is a row, so it follows the row rule: the name is a link,
 * and what needs a sentence to say what it is about to do lives here.
 */
export function OrgUnitDetailPage() {
  const { id } = useParams();
  const can = useCan();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApiResource<OrgUnitDetail>(
    `/api/admin/org-units/${id}`,
  );
  // Its error state is deliberately ignored, as on the account record: a
  // caller who may read the directory but not its sources gets a unit that
  // still renders and simply cannot name the directory that owns it.
  const { data: sourcesData } = useApiResource<{
    sources: { id: string; name: string }[];
  }>('/api/admin/sources');

  const [editing, setEditing] = useState(false);
  // Fetched only to fill the parent picker, and only while it is open. The
  // record needs one unit; the tree is the move form's requirement, not the
  // screen's.
  const { data: unitList } = useApiResource<{
    orgUnits: { id: string; name: string }[];
  }>(editing ? '/api/admin/org-units' : null);

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

  return (
    <>
      <PageHeader
        title={data.name}
        actions={
          // Only for a locally managed unit. The next sync run reads the unit
          // out of the directory and writes its name and place back, so this
          // form would offer a change that silently reverts.
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
            label: 'Parent',
            value: data.parent ? (
              <Link
                to={`/admin/org-units/${data.parent.id}`}
                className="text-ink underline-offset-2 hover:text-primary hover:underline"
              >
                {data.parent.name}
              </Link>
            ) : (
              // Said, not left blank. An empty cell reads as a fact nobody
              // looked up; sitting at the top of the tree is a fact.
              <span className="font-normal text-muted">Top level</span>
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
              // Named, not merely flagged: "synced" tells an administrator
              // nothing about where to go and change it.
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
            path={`/api/admin/org-units/${data.id}`}
            initial={{ name: data.name, parentId: data.parentId ?? '' }}
            onCancel={() => setEditing(false)}
            onCreated={() => {
              setEditing(false);
              reload();
            }}
            build={(v) => ({
              name: v.name ?? '',
              // NULL means top level. Omitting would mean "leave alone", so a
              // unit could never be moved OUT of its parent.
              parentId: v.parentId === '' ? null : (v.parentId ?? null),
            })}
            fields={(v, set, errs) => (
              <>
                <Field
                  label="Name"
                  value={v.name ?? ''}
                  onChange={(x) => set('name', x)}
                  error={errs.name}
                />
                <Select
                  label="Parent"
                  value={v.parentId ?? ''}
                  onChange={(x) => set('parentId', x)}
                  error={errs.parentId}
                  options={[
                    { value: '', label: 'No parent — top level' },
                    // ITSELF EXCLUDED. The API refuses a cycle and marks the
                    // field, but offering the move invites it — the shortest
                    // cycle is a unit named as its own parent, one click away
                    // in an unfiltered list.
                    ...(unitList?.orgUnits ?? [])
                      .filter((u) => u.id !== data.id)
                      .map((u) => ({ value: u.id, label: u.name })),
                  ]}
                />
              </>
            )}
          />
        )}

        {/*
          What the list could not show, and what the delete is really about.
          Seeing who is in the unit is seeing why the delete will be refused,
          before the reader has typed the unit's name to confirm it.
        */}
        <Panel title="Users in this unit">
          {data.users.length === 0 ? (
            <div className="p-6">
              <Empty title="Nobody is in this unit">
                Move an account into it from the account's own record.
              </Empty>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Login</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <Link
                        to={`/admin/users/${user.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {user.displayName}
                      </Link>
                    </td>
                    <td className="font-mono text-sm">{user.login}</td>
                    <td>
                      {/* A deactivated account still occupies the unit and
                          still blocks the delete. Listing only active ones
                          would leave the reader with an empty unit and a 409
                          that disagrees with it. */}
                      <Status tone={user.status === 'active' ? 'active' : 'inactive'}>
                        {user.status === 'active' ? 'Active' : 'Inactive'}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Child units">
          {data.children.length === 0 ? (
            <div className="p-6">
              <Empty title="Nothing beneath this unit">
                A unit can hold others — a site under a region, a team under a
                department.
              </Empty>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.children.map((child) => (
                  <tr key={child.id}>
                    <td>
                      <Link
                        to={`/admin/org-units/${child.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {child.name}
                      </Link>
                    </td>
                    <td>
                      <Status
                        tone={child.status === 'active' ? 'active' : 'inactive'}
                      >
                        {child.status === 'active' ? 'Active' : 'Inactive'}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Status">
          <div className="flex flex-wrap items-start justify-between gap-4 p-4">
            <div className="min-w-[16rem] max-w-md">
              {local ? (
                <StatusToggle
                  active={data.status === 'active'}
                  basePath={`/api/admin/org-units/${data.id}`}
                  label="org unit"
                  consequences="Users stay where they are. The unit grants nothing — neither its applications nor a role scoped to it."
                  onChanged={reload}
                />
              ) : (
                // The next sync run reads the unit as present in the directory
                // and puts it back, so the button would appear to work and
                // then quietly undo itself. Saying who owns it is the honest
                // answer — the same one the account record gives.
                <span className="text-sm text-muted">
                  {source?.name ?? 'A directory source'} owns this unit, and the
                  next sync run would put it back
                </span>
              )}
            </div>

            {can('directory.delete') && (
              <div className="min-w-[16rem] max-w-md">
                {/* Offered second, and refused by the server unless the unit is
                    empty. Deactivating keeps the users where they are; this
                    cannot, which is why "move them first" is the server's
                    answer rather than a silent reparent. */}
                <DeleteButton
                  path={`/api/admin/org-units/${data.id}`}
                  label="org unit"
                  confirmWord={data.name}
                  warning="The unit is removed from the directory and from Syntra. It has to be empty first — a deactivated user still counts as being in it. This cannot be undone."
                  // Back to the list, not back to this screen: staying would
                  // leave the reader looking at a record that no longer exists
                  // and a page whose every control now answers 404.
                  onDeleted={() => navigate('/admin/org-units')}
                />
              </div>
            )}
          </div>
        </Panel>

        {/* Materialising a unit into a directory container is an act on THIS
            unit, so it belongs on its record beside the other three. It used
            to sit on the list, where a row carried a button for a panel about
            one unit while the row beside it carried the same. */}
        {can('provision.manage') && <ContainersPanel unit={data} />}

        <SubjectLog subjects={[data.id]} />

        <Link
          to="/admin/org-units"
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to org units
        </Link>
      </div>
    </>
  );
}
