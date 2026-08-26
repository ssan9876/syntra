import { useState } from 'react';
import { Alert, Button, Check, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  builtIn: boolean;
  assignmentCount: number;
}

/**
 * Administrative roles, and the permissions they carry.
 *
 * There was no screen and no API. `Role.permissions` was a snapshot the seed
 * wrote once, so an installation upgraded past the commit that added
 * `deployment.manage` had an Owner that did not hold it -- the Updates page was
 * hidden, every update route answered 403, and the only remedy was raw SQL.
 * This page is the path back, and the checkbox for a catalogue permission the
 * role does not yet hold is the specific control that closes it.
 *
 * The catalogue comes from the server on every load rather than being listed
 * here. A copy in the bundle would be a second definition of a closed set that
 * `hasPermission` compares against, and it would be wrong the first time
 * somebody added a permission and did not think of this file.
 */
export function RolesPage() {
  const { data, error, loading, reload } = useApiResource<{
    catalog: string[];
    roles: RoleRow[];
  }>('/api/admin/roles');

  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (role: RoleRow) => {
    setEditing(role);
    setChosen(new Set(role.permissions));
    setName(role.name);
    setProblem(null);
  };

  const toggle = (permission: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(permission);
    else next.delete(permission);
    setChosen(next);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/roles/${editing.id}`, {
        method: 'PATCH',
        // The permission set is REPLACED whole, so the whole set is sent. An
        // add/remove vocabulary would need a merge rule nobody looking at a
        // page of checkboxes could predict.
        body: JSON.stringify({ name, permissions: [...chosen] }),
      });
      setEditing(null);
      reload();
    } catch (cause) {
      // The server's own sentence, always. The refusal that matters most here
      // -- "that would leave nobody able to administer roles" -- is one the
      // reader can act on, and flattening it to "something went wrong" leaves
      // them pressing Save again.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That role could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role: RoleRow) => {
    setProblem(null);
    try {
      await api(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That role could not be deleted.',
      );
    }
  };

  return (
    <>
      <PageHeader
        title="Roles"
        description="What an administrator may do, and who holds it. A role's permissions are stored on the role, so a permission added by an upgrade has to be granted here before anybody has it."
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}

      {editing && (
        <div className="mb-6">
          <Panel
            title={`Edit ${editing.name}`}
            {...(editing.builtIn
              ? {
                  description:
                    'A built-in role. Its permissions are editable — that is how a permission added by an upgrade reaches the person who needs it — but it cannot be deleted.',
                }
              : {})}
          >
            <div className="space-y-4 p-4">
              <Field label="Name" value={name} onChange={setName} />
              <fieldset aria-label="Permissions" className="space-y-2">
                <legend className="mb-1.5 font-medium text-ink">Permissions</legend>
                {(data?.catalog ?? []).map((permission) => (
                  <Check
                    key={permission}
                    checked={chosen.has(permission)}
                    onChange={(on) => toggle(permission, on)}
                    label={permission}
                  />
                ))}
              </fieldset>
              <div className="flex gap-2">
                <Button variant="primary" loading={busy} onClick={save}>
                  Save
                </Button>
                <Button variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </Panel>
        </div>
      )}

      <Panel>
        {loading && <SkeletonRows rows={3} cols={3} />}
        {!loading && (data?.roles ?? []).length === 0 && (
          <div className="p-6">
            <Empty title="No roles yet">
              A role is a named set of permissions. Nobody can reach the console without
              one.
            </Empty>
          </div>
        )}
        {!loading && data && data.roles.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {data.roles.map((role) => (
              <li key={role.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span>
                  <span className="font-medium text-ink">{role.name}</span>
                  {/* `Status` takes only `tone` and `children`, so the spacing
                      lives on a wrapper rather than a className it would
                      ignore. */}
                  {role.builtIn && (
                    <span className="ml-2">
                      <Status tone="neutral">built in</Status>
                    </span>
                  )}
                  <span className="ml-2 text-muted">
                    {role.assignmentCount} holder{role.assignmentCount === 1 ? '' : 's'} ·{' '}
                    {role.permissions.length} permission
                    {role.permissions.length === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => open(role)}>
                    Edit
                  </Button>
                  {/* A built-in role is what the seed wrote and what the
                      permission backfill targets, and RoleAssignment cascades
                      from Role — so the control is not offered rather than
                      offered and refused. */}
                  {!role.builtIn && (
                    <Button size="sm" variant="ghost" onClick={() => remove(role)}>
                      Delete
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
