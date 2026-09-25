import { useState } from 'react';
import {
  Alert,
  Button,
  Check,
  Empty,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Panel,
  Select,
  SkeletonRows,
  Status,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { DeleteButton } from './DeleteButton.js';
import { formFieldErrors, summaryErrors } from './RecordPanel.js';
import { PageHeader } from './PageHeader.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';

interface Holder {
  userId: string;
  login: string;
  displayName: string;
  status: string;
  scopeOrgUnitId: string | null;
}

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  builtIn: boolean;
  assignmentCount: number;
  holders: Holder[];
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

  // Narrowed once, and shared by the summary cards and the table below.
  const roles = data?.roles ?? [];

  /**
   * The open form, or nothing. `id === null` is a role that does not exist
   * yet.
   *
   * One form for both, rather than a create panel beside an edit panel. The
   * two differ in the verb on the button and the endpoint the body goes to;
   * everything a reader looks at -- the name, the description, the fieldset of
   * permissions -- is the same question asked about the same object, and two
   * copies of it would drift the first time somebody added a field to one.
   */
  const [form, setForm] = useState<{ id: string | null; builtIn: boolean } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The editor's own refusal, kept apart from `problem`. That one is for the
   * list's controls — grant, revoke — and belongs at the top of the page; a
   * refused SAVE belongs in the form that was refused, at the top of it,
   * focused, where the sticky save bar has just been pressed.
   */
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  /** What the editor opened with, for "Unsaved changes". */
  const [opened, setOpened] = useState<{ name: string; description: string; permissions: string[] }>({
    name: '',
    description: '',
    permissions: [],
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  /** Which role's grant picker is open, and who is selected in it. */
  const [granting, setGranting] = useState<string | null>(null);
  const [grantee, setGrantee] = useState('');
  /** Where the grant applies. '' is the whole tenant, which is the default. */
  const [grantScope, setGrantScope] = useState('');

  /**
   * The accounts a role can be granted to.
   *
   * `rbac.manage` and `directory.read` are separate permissions and a caller
   * may hold the first without the second, so this read can fail on a page
   * that must still render. It does not take the page down — but its failure
   * is READ rather than ignored, which it was not.
   *
   * Ignoring it made the two opposite causes of an empty list
   * indistinguishable: everybody already holds the role, or the caller cannot
   * see who exists. The screen reported the second as the first, so it stated
   * something false about the tenant and withheld the only control on the row.
   */
  const {
    data: usersData,
    error: usersError,
    loading: usersLoading,
  } = useApiResource<{
    users: { id: string; login: string; displayName: string; status: string }[];
  }>('/api/admin/users');

  /**
   * The units a grant can be confined to.
   *
   * Gated on `directory.read`, the same permission as the account list above,
   * so the two fail together and the one refusal already on screen covers
   * both. Read here rather than resolved by the server because the picker
   * needs the whole list anyway, and the holders' unit names are then a
   * lookup in memory rather than a second shape on the roles response.
   */
  const { data: unitsData } = useApiResource<{
    orgUnits: { id: string; name: string }[];
  }>('/api/admin/org-units');

  const unitNames = new Map((unitsData?.orgUnits ?? []).map((u) => [u.id, u.name]));

  const open = (role: RoleRow) => {
    setForm({ id: role.id, builtIn: role.builtIn });
    setChosen(new Set(role.permissions));
    setName(role.name);
    setDescription(role.description ?? '');
    setOpened({
      name: role.name,
      description: role.description ?? '',
      permissions: [...role.permissions],
    });
    setProblem(null);
    setFormProblem(null);
    setFormErrors({});
  };

  /**
   * A role that does not exist yet, which is what the screen was missing.
   *
   * `POST /api/admin/roles` was built, guarded by `rbac.manage` and audited in
   * the same transaction as the write, and then called by nothing: the console
   * only ever PATCHed an id it already had. So an installation had the roles
   * its seed wrote and no others, and "the help desk may read the directory
   * and nothing else" was a database client -- the same state the role API
   * exists to end, one door further along.
   *
   * Nothing is preselected. A new role starting from Owner's permissions
   * would be a narrower role only if somebody remembered to narrow it, and the
   * failure is silent and total.
   */
  const create = () => {
    setForm({ id: null, builtIn: false });
    setChosen(new Set());
    setName('');
    setDescription('');
    setOpened({ name: '', description: '', permissions: [] });
    setProblem(null);
    setFormProblem(null);
    setFormErrors({});
  };

  const toggle = (permission: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(permission);
    else next.delete(permission);
    setChosen(next);
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setFormProblem(null);
    setFormErrors({});
    try {
      const body = JSON.stringify({
        name,
        // Empty means absent, not an empty description. `roleBody` takes null
        // for the first and the list renders nothing for it; a stored '' would
        // be a description that exists and says nothing.
        description: description.trim() === '' ? null : description,
        // The permission set is REPLACED whole, so the whole set is sent. An
        // add/remove vocabulary would need a merge rule nobody looking at a
        // page of checkboxes could predict.
        permissions: [...chosen],
      });
      await (form.id === null
        ? // The COLLECTION. Posting to a role's own path would edit it.
          api('/api/admin/roles', { method: 'POST', body })
        : api(`/api/admin/roles/${form.id}`, { method: 'PATCH', body }));
      toast({
        tone: 'success',
        title: form.id === null ? `${name.trim()} created` : `${name.trim()} saved`,
      });
      setForm(null);
      reload();
    } catch (cause) {
      // The server's own sentence, always. The refusal that matters most here
      // -- "that would leave nobody able to administer roles" -- is one the
      // reader can act on, and flattening it to "something went wrong" leaves
      // them pressing Save again.
      const marked = formFieldErrors(cause);
      setFormErrors(marked);
      setFormProblem(
        Object.keys(marked).length > 0
          ? null
          : cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'That role could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * The catalogue, in groups taken from the part before the dot.
   *
   * DERIVED rather than mapped. The catalogue travels from the server on every
   * load precisely so that no second copy of it lives in this bundle, and a
   * hand-written heading per permission would be exactly that copy -- wrong
   * the first time somebody adds one and does not think of this file. A split
   * on '.' cannot go out of step: a new permission lands in its module's
   * group, or makes a new group, with nobody editing anything here.
   *
   * Insertion order, so the groups arrive in the order `permissions.ts`
   * declares them. Alphabetising would put `access` above `directory` and
   * scatter the reading order the catalogue was written in.
   */
  const groups = (() => {
    const byModule = new Map<string, string[]>();
    for (const permission of data?.catalog ?? []) {
      const module = permission.split('.')[0] ?? permission;
      byModule.set(module, [...(byModule.get(module) ?? []), permission]);
    }
    return [...byModule];
  })();

  /**
   * Accounts not already holding this role AT THE CHOSEN SCOPE.
   *
   * Scope-dependent, not merely "does not hold it anywhere". Somebody holding
   * the role over Cardiology is a perfectly good candidate for Oncology, and
   * excluding them for holding it somewhere makes the second grant
   * unreachable; offering them for Cardiology again invites the refusal of the
   * unique index on (role, user, scope).
   */
  const grantable = (role: RoleRow, scope: string) => {
    const held = new Set(
      role.holders
        .filter((h) => (h.scopeOrgUnitId ?? '') === scope)
        .map((h) => h.userId),
    );
    return (usersData?.users ?? []).filter((u) => !held.has(u.id));
  };

  const grant = async (role: RoleRow) => {
    if (!grantee) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/roles/${role.id}/assignments`, {
        method: 'POST',
        // Explicitly null for the tenant-wide case, never absent. The two
        // readings of a missing field are "everywhere" and "I forgot", and
        // that is the difference between one department and the whole tenant.
        body: JSON.stringify({
          userId: grantee,
          scopeOrgUnitId: grantScope === '' ? null : grantScope,
        }),
      });
      setGranting(null);
      setGrantee('');
      setGrantScope('');
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That role could not be granted.',
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (role: RoleRow, holder: Holder) => {
    setProblem(null);
    try {
      // The scope only where there is one. A bare path has always meant every
      // scope, and a tenant-wide holder has exactly one — so saying nothing is
      // both correct and unchanged for them.
      const scope =
        holder.scopeOrgUnitId === null
          ? ''
          : `?scopeOrgUnitId=${encodeURIComponent(holder.scopeOrgUnitId)}`;
      await api(`/api/admin/roles/${role.id}/assignments/${holder.userId}${scope}`, {
        method: 'DELETE',
      });
      reload();
    } catch (cause) {
      // The refusal worth reading is the anti-lockout one: taking the last
      // holder of rbac.manage off leaves nobody able to put it back.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : `${holder.login} could not be revoked.`,
      );
    }
  };

  const dirty =
    form !== null &&
    (name !== opened.name ||
      description !== opened.description ||
      chosen.size !== opened.permissions.length ||
      opened.permissions.some((p) => !chosen.has(p)));

  return (
    <>
      <PageHeader
        title="Roles"
        actions={
          <Button variant="primary" onClick={create}>
            New role
          </Button>
        }
      />

      {/* A role nobody holds is the one worth seeing: it is either a
          mistake or a permission set that quietly stopped being used, and
          neither is visible from a table sorted by name. */}
      <StatGrid>
        <StatCard label="Roles" value={roles.length} />
        <StatCard label="Built in" value={roles.filter((r) => r.builtIn).length} />
        <StatCard
          label="Held by nobody"
          value={roles.filter((r) => r.assignmentCount === 0).length}
          tone="warning"
          quietWhenZero
        />
      </StatGrid>

      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}

      {form && (
        // The form wraps the panel rather than sitting inside it so the save
        // bar can be sticky: the permission list runs to several screens, and
        // `Panel` clips its overflow, which would pin the bar to the panel.
        <form
          noValidate
          className="mb-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen.size > 0 && name.trim() !== '') void save();
          }}
        >
          <Panel
            title={form.id === null ? 'New role' : `Edit ${opened.name}`}
            // A fact about the role, labelled as one. This was a sentence
            // passed as a `description` the panel never rendered.
            actions={form.builtIn ? <Status tone="neutral">Built in, cannot be deleted</Status> : null}
            bodyClassName="space-y-8 p-4"
          >
            <ErrorSummary
              errors={summaryErrors(
                formErrors,
                { name: 'Name', description: 'Description', permissions: 'Permissions' },
                formProblem,
              )}
              {...(Object.keys(formErrors).length === 0 ? { title: 'Not saved' } : {})}
            />

            <FormSection title="Role">
              <Field
                name="name"
                label="Name"
                value={name}
                onChange={setName}
                error={formErrors.name}
              />
              {/* The API has stored one since the role table existed and
                  nothing ever set it. Survivable while there was one built-in
                  role whose name said everything; not once there are four
                  narrow ones whose names do not. */}
              <Field
                name="description"
                label="Description"
                value={description}
                onChange={setDescription}
                maxLength={1000}
                error={formErrors.description}
              />
            </FormSection>

            <FormSection
              title="Permissions"
              status={
                <span className="text-muted tabular-nums">
                  {chosen.size} of {data?.catalog.length ?? 0} chosen
                </span>
              }
            >
              {/* The visible heading is the section's; the fieldset keeps its
                  own accessible name so the group of boxes is still announced
                  as "Permissions" by whoever tabs into it. */}
              <fieldset aria-label="Permissions" className="grid gap-6 sm:col-span-2 sm:grid-cols-2">
                <legend className="sr-only">Permissions</legend>
                {/* Grouped by module, because twenty-four dotted keys in one
                    flat list is a list you can read but not choose from:
                    picking a narrow set means knowing from memory that
                    `directory.delete` is a right separate from
                    `directory.write`. A module holding one permission still
                    gets a heading — the alternative is a rule about when
                    grouping applies that the reader has to work out. */}
                {groups.map(([module, permissions]) => (
                  <fieldset key={module} aria-label={module} className="space-y-2">
                    <legend className="mb-1.5 text-sm font-medium text-muted">
                      {module}
                    </legend>
                    {permissions.map((permission) => (
                      <Check
                        key={permission}
                        checked={chosen.has(permission)}
                        onChange={(on) => toggle(permission, on)}
                        label={permission}
                      />
                    ))}
                  </fieldset>
                ))}
              </fieldset>
            </FormSection>
          </Panel>

          <FormActions
            sticky
            status={
              chosen.size === 0 ? (
                // Why Save is disabled, beside it. `roleBody` requires at
                // least one: a role granting nothing is indistinguishable from
                // a mistake, and deleting it is how you say that.
                <span className="text-warning">Choose at least one permission</span>
              ) : dirty ? (
                <span className="text-muted">Unsaved changes</span>
              ) : null
            }
          >
            <Button type="button" variant="secondary" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={chosen.size === 0 || name.trim() === ''}
            >
              {form.id === null ? 'Create' : 'Save'}
            </Button>
          </FormActions>
        </form>
      )}

      <Panel>
        {loading && <SkeletonRows rows={3} cols={3} />}
        {!loading && (data?.roles ?? []).length === 0 && (
          <div className="p-6">
            <Empty
              title="No roles yet"
              action={
                <Button variant="primary" onClick={create}>
                  New role
                </Button>
              }
            >
              A role is a named set of permissions. Nobody can reach the console without
              one.
            </Empty>
          </div>
        )}
        {!loading && data && data.roles.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {data.roles.map((role) => (
              <li key={role.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
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
                <span className="ml-auto flex flex-wrap items-start justify-end gap-2">
                  <Button size="sm" variant="secondary" onClick={() => open(role)}>
                    Edit
                  </Button>
                  {/* A built-in role is what the seed wrote and what the
                      permission backfill targets, and RoleAssignment cascades
                      from Role — so the control is not offered rather than
                      offered and refused. */}
                  {/* Typed confirmation, like every other delete in the console:
                      this one also takes the role off everybody holding it,
                      because RoleAssignment cascades from Role. */}
                  {!role.builtIn && (
                    <DeleteButton
                      path={`/api/admin/roles/${role.id}`}
                      label="role"
                      confirmWord={role.name}
                      warning={
                        role.assignmentCount === 0
                          ? 'Nobody holds it, so nobody loses anything.'
                          : `${role.assignmentCount} ${role.assignmentCount === 1 ? 'holder loses' : 'holders lose'} every permission it grants.`
                      }
                      onDeleted={() => {
                        toast({ tone: 'success', title: `${role.name} deleted` });
                        reload();
                      }}
                    />
                  )}
                </span>
                </div>

                {/* What the name does not say. A narrow role is named for the
                    job and not for the rights, so "Help desk" is only legible
                    beside the sentence its author wrote about it. */}
                {role.description && (
                  <p className="mt-1 text-sm text-muted">{role.description}</p>
                )}

                {/* WHO holds it, not just how many. The count above was the
                    whole of what this screen said, and a count is not
                    something anybody can revoke from -- so taking a role off
                    somebody still meant a database client, which is the gap
                    the role API existed to close. */}
                <div className="mt-2 pl-1">
                  {role.holders.length === 0 ? (
                    <p className="text-sm text-muted">Nobody holds this role.</p>
                  ) : (
                    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {role.holders.map((holder) => (
                        <li
                          // The scope is part of the identity: one account can
                          // hold the role tenant-wide AND over a unit, which is
                          // two rows and was two identical ones.
                          key={`${holder.userId}:${holder.scopeOrgUnitId ?? ''}`}
                          className="flex items-center gap-2 text-sm"
                        >
                          <span className="text-ink">{holder.login}</span>
                          {/* Only where there is one. Saying "everywhere" on
                              every tenant-wide row would put the word on
                              almost every row on the screen, which is how a
                              distinction stops being visible. */}
                          {holder.scopeOrgUnitId !== null && (
                            <Status tone="neutral">
                              {unitNames.get(holder.scopeOrgUnitId) ?? 'scoped'}
                            </Status>
                          )}
                          {holder.status !== 'active' && (
                            // Shown rather than filtered away: a deactivated
                            // account still holds the role, and still counts
                            // toward the anti-lockout guard.
                            <Status tone="inactive">cannot sign in</Status>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            // Named by scope where there is one, so two
                            // grants to one account are two distinguishable
                            // controls rather than the same label twice.
                            aria-label={
                              holder.scopeOrgUnitId === null
                                ? `Revoke ${holder.login}`
                                : `Revoke ${holder.login} in ${
                                    unitNames.get(holder.scopeOrgUnitId) ?? 'one unit'
                                  }`
                            }
                            onClick={() => revoke(role, holder)}
                          >
                            Revoke
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {granting === role.id ? (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      {/* No explanation beside it, deliberately. The option
                          text IS the explanation: "Everywhere in this tenant"
                          says what the grant will DO, where "unscoped" names a
                          column. A control that needs a paragraph to be usable
                          is a control that should be reworded. */}
                      <Select
                        label="Scope"
                        value={grantScope}
                        onChange={(value) => {
                          setGrantScope(value);
                          // The candidates depend on it, so a choice made
                          // before the scope changed may no longer be one.
                          setGrantee('');
                        }}
                        options={[
                          { value: '', label: 'Everywhere in this tenant' },
                          ...(unitsData?.orgUnits ?? []).map((unit) => ({
                            value: unit.id,
                            label: unit.name,
                          })),
                        ]}
                      />
                      <Select
                        label="Account"
                        value={grantee}
                        onChange={setGrantee}
                        options={[
                          { value: '', label: 'Choose an account' },
                          ...grantable(role, grantScope).map((u) => ({
                            value: u.id,
                            label: u.login,
                          })),
                        ]}
                      />
                      <Button
                        size="sm"
                        disabled={grantee === '' || busy}
                        loading={busy}
                        onClick={() => void grant(role)}
                      >
                        Grant
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setGranting(null);
                          setGrantee('');
                          setGrantScope('');
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : usersError ? (
                    // Named, not merely refused. The reader cannot grant
                    // themselves `directory.read`, but they cannot ask
                    // somebody for a right they cannot name either — and on
                    // this screen it is a literal row in the fieldset above,
                    // not jargon. Revoking is untouched: the holders travel
                    // with the role and need no directory read at all.
                    <p className="mt-2 text-sm text-muted">
                      Granting needs directory.read, which this account does not hold.
                    </p>
                  ) : usersLoading ? null : grantable(role, '').length === 0 ? (
                    <p className="mt-2 text-sm text-muted">
                      Everybody who can sign in already holds it.
                    </p>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2"
                      onClick={() => {
                        setGranting(role.id);
                        setGrantee('');
                        setGrantScope('');
                        setProblem(null);
                      }}
                    >
                      Grant to someone
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
