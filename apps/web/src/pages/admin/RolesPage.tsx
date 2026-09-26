import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Empty,
  ErrorSummary,
  Field,
  FormActions,
  Meter,
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

/** `directory.read` → module `directory`, action `read`; `identity.sensitive.read` → `sensitive read`. */
const moduleOf = (permission: string) => permission.split('.')[0] ?? permission;
const actionOf = (permission: string) => permission.split('.').slice(1).join(' ') || permission;
const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const initials = (holder: Holder) =>
  (holder.displayName || holder.login)
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

/**
 * Administrative roles, and the permissions they carry.
 *
 * A list and a record, side by side. The list answers "which roles exist and
 * how much does each one carry" -- the meter is the share of the catalogue a
 * role holds, which is the first thing anybody auditing roles asks. The record
 * answers "who has it and what exactly can they do": people as chips they can
 * be revoked from, and the permissions as a grid by module, the same grid in
 * view and in edit so an edit is a change to what was just read rather than a
 * different screen.
 *
 * The catalogue comes from the server on every load rather than being listed
 * here. A copy in the bundle would be a second definition of a closed set that
 * `hasPermission` compares against, and it would be wrong the first time
 * somebody added a permission and did not think of this file. The same goes
 * for the module grouping: derived from the part before the dot, in the order
 * `permissions.ts` declares them.
 */
export function RolesPage() {
  const { data, error, loading, reload } = useApiResource<{
    catalog: string[];
    roles: RoleRow[];
  }>('/api/admin/roles');
  const roles = data?.roles ?? [];
  const catalog = data?.catalog ?? [];

  // The selection is a location, like a tab: a link to "the Help desk role"
  // pasted into a ticket must open on it.
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('role');
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0] ?? null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('role', id);
    setParams(next, { replace: true });
  };

  /** The open editor, or nothing. `id === null` is a role that does not exist yet. */
  const [form, setForm] = useState<{ id: string | null; builtIn: boolean } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<{ name: string; description: string; permissions: string[] }>({
    name: '',
    description: '',
    permissions: [],
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [granting, setGranting] = useState(false);
  const [grantee, setGrantee] = useState('');
  /** Where the grant applies. '' is the whole tenant, which is the default. */
  const [grantScope, setGrantScope] = useState('');

  /**
   * The accounts a role can be granted to. `rbac.manage` and `directory.read`
   * are separate permissions, so this read can fail on a page that must still
   * render -- and its failure is read, so "everybody holds it" and "you cannot
   * see who exists" stay two different things on screen.
   */
  const {
    data: usersData,
    error: usersError,
    loading: usersLoading,
  } = useApiResource<{
    users: { id: string; login: string; displayName: string; status: string }[];
  }>('/api/admin/users');

  const { data: presetsData } = useApiResource<{
    presets: { key: string; name: string; permissions: string[] }[];
  }>('/api/admin/roles/presets');
  // Offered only while no role of that name exists: adding it twice is a 409.
  const presets = (presetsData?.presets ?? []).filter(
    (preset) => !roles.some((role) => role.name === preset.name),
  );

  const addPreset = async (key: string, presetName: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const created = await api<{ id?: string }>(`/api/admin/roles/presets/${key}`, { method: 'POST' });
      toast({ tone: 'success', title: `${presetName} added` });
      if (created && typeof created === 'object' && created.id) select(created.id);
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : `${presetName} could not be added.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const { data: unitsData } = useApiResource<{
    orgUnits: { id: string; name: string }[];
  }>('/api/admin/org-units');
  const unitNames = new Map((unitsData?.orgUnits ?? []).map((u) => [u.id, u.name]));

  const reset = () => {
    setProblem(null);
    setFormProblem(null);
    setFormErrors({});
    setGranting(false);
  };

  const edit = (role: RoleRow) => {
    setForm({ id: role.id, builtIn: role.builtIn });
    setChosen(new Set(role.permissions));
    setName(role.name);
    setDescription(role.description ?? '');
    setOpened({ name: role.name, description: role.description ?? '', permissions: [...role.permissions] });
    reset();
  };

  /** Nothing preselected: a narrower role copied from Owner is narrower only if somebody remembers. */
  const create = () => {
    setForm({ id: null, builtIn: false });
    setChosen(new Set());
    setName('');
    setDescription('');
    setOpened({ name: '', description: '', permissions: [] });
    reset();
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
        // Empty means absent, not an empty description.
        description: description.trim() === '' ? null : description,
        // The permission set is REPLACED whole, so the whole set is sent.
        permissions: [...chosen],
      });
      const saved = await (form.id === null
        ? api<{ id?: string }>('/api/admin/roles', { method: 'POST', body })
        : api<{ id?: string }>(`/api/admin/roles/${form.id}`, { method: 'PATCH', body }));
      toast({
        tone: 'success',
        title: form.id === null ? `${name.trim()} created` : `${name.trim()} saved`,
      });
      if (form.id === null && saved && typeof saved === 'object' && saved.id) select(saved.id);
      setForm(null);
      reload();
    } catch (cause) {
      // The server's own sentence: "that would leave nobody able to administer
      // roles" is one the reader can act on.
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

  const groups = (() => {
    const byModule = new Map<string, string[]>();
    for (const permission of catalog) {
      const module = moduleOf(permission);
      byModule.set(module, [...(byModule.get(module) ?? []), permission]);
    }
    return [...byModule];
  })();

  /** Accounts not already holding this role AT THE CHOSEN SCOPE. */
  const grantable = (role: RoleRow, scope: string) => {
    const held = new Set(
      role.holders.filter((h) => (h.scopeOrgUnitId ?? '') === scope).map((h) => h.userId),
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
        // Explicitly null for the tenant-wide case, never absent.
        body: JSON.stringify({
          userId: grantee,
          scopeOrgUnitId: grantScope === '' ? null : grantScope,
        }),
      });
      setGranting(false);
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
      // A bare path means every scope; a tenant-wide holder has exactly one.
      const scope =
        holder.scopeOrgUnitId === null
          ? ''
          : `?scopeOrgUnitId=${encodeURIComponent(holder.scopeOrgUnitId)}`;
      await api(`/api/admin/roles/${role.id}/assignments/${holder.userId}${scope}`, {
        method: 'DELETE',
      });
      reload();
    } catch (cause) {
      // The refusal worth reading is the anti-lockout one.
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

  const editingSelected = form !== null && form.id !== null && form.id === selected?.id;
  const creating = form !== null && form.id === null;

  return (
    <>
      <PageHeader
        title="Roles"
        actions={
          <Button variant="primary" onClick={create} disabled={creating}>
            New role
          </Button>
        }
      />

      <StatGrid>
        <StatCard label="Roles" value={roles.length} />
        <StatCard label="Built in" value={roles.filter((r) => r.builtIn).length} />
        <StatCard
          label="Held by nobody"
          value={roles.filter((r) => r.assignmentCount === 0).length}
          tone="warning"
          quietWhenZero
        />
        <StatCard label="Permissions" value={catalog.length} />
      </StatGrid>

      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}

      {loading && (
        <Panel>
          <SkeletonRows rows={3} cols={3} />
        </Panel>
      )}

      {!loading && roles.length === 0 && !creating && (
        <Panel>
          <div className="p-6">
            <Empty
              title="No roles yet"
              action={
                <Button variant="primary" onClick={create}>
                  New role
                </Button>
              }
            />
          </div>
        </Panel>
      )}

      {!loading && (roles.length > 0 || creating) && (
        <div className="grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          {/* The list. Selecting is a navigation, so it is a list of buttons
              with the current one marked, not a table of rows. */}
          <nav aria-label="Roles" className="lg:sticky lg:top-20">
            <ul className="space-y-1.5">
              {roles.map((role) => {
                const current = !creating && role.id === selected?.id;
                const share = catalog.length === 0 ? 0 : (role.permissions.length / catalog.length) * 100;
                return (
                  <li key={role.id}>
                    <button
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      onClick={() => {
                        if (form !== null && dirty) return;
                        setForm(null);
                        reset();
                        select(role.id);
                      }}
                      className={[
                        'w-full rounded-panel border px-3.5 py-3 text-left',
                        'transition-colors duration-150 ease-out-quart',
                        current
                          ? 'border-primary/50 bg-bg shadow-raised'
                          : 'border-border-subtle bg-surface hover:bg-bg',
                      ].join(' ')}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`min-w-0 flex-1 truncate font-semibold ${current ? 'text-primary' : 'text-ink'}`}>
                          {role.name}
                        </span>
                        {role.builtIn && <Status tone="neutral">built in</Status>}
                      </span>
                      <span className="mt-1 block text-sm tabular-nums text-muted">
                        {role.assignmentCount} holder{role.assignmentCount === 1 ? '' : 's'} ·{' '}
                        {role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'}
                      </span>
                      <span className="mt-2 block">
                        <Meter
                          percent={share}
                          label={`of ${catalog.length} permissions`}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {presets.length > 0 && (
              <div className="mt-4">
                <h2 className="mb-1.5 px-1 text-xs font-semibold tracking-wide text-muted">Add a preset</h2>
                <ul className="flex flex-wrap gap-1.5">
                  {presets.map((preset) => (
                    <li key={preset.key}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void addPreset(preset.key, preset.name)}
                        title={`${preset.permissions.length} permissions`}
                        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-control px-2.5 py-0.5 text-sm text-muted transition-colors duration-150 ease-out-quart hover:border-primary hover:text-primary disabled:opacity-50"
                      >
                        <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
                          <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                        {preset.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </nav>

          {/* The record, or the editor over it. */}
          {creating || editingSelected ? (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (chosen.size > 0 && name.trim() !== '') void save();
              }}
            >
              <Panel
                title={form!.id === null ? 'New role' : `Edit ${opened.name}`}
                actions={form!.builtIn ? <Status tone="neutral">Built in</Status> : null}
                bodyClassName="space-y-6 p-5"
              >
                <ErrorSummary
                  errors={summaryErrors(
                    formErrors,
                    { name: 'Name', description: 'Description', permissions: 'Permissions' },
                    formProblem,
                  )}
                  {...(Object.keys(formErrors).length === 0 ? { title: 'Not saved' } : {})}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field name="name" label="Name" value={name} onChange={setName} error={formErrors.name} />
                  <Field
                    name="description"
                    label="Description"
                    value={description}
                    onChange={setDescription}
                    maxLength={1000}
                    error={formErrors.description}
                  />
                </div>
                <PermissionGrid
                  groups={groups}
                  held={chosen}
                  onToggle={toggle}
                  count={`${chosen.size} of ${catalog.length}`}
                />
              </Panel>
              <FormActions
                sticky
                status={
                  chosen.size === 0 ? (
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
                  {form!.id === null ? 'Create' : 'Save'}
                </Button>
              </FormActions>
            </form>
          ) : selected ? (
            <Panel bodyClassName="divide-y divide-border-subtle">
              <header className="flex flex-wrap items-start gap-3 bg-surface px-5 py-4">
                <div className="min-w-0 flex-1">
                  <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-ink">
                    {selected.name}
                    {selected.builtIn && <Status tone="neutral">built in</Status>}
                  </h2>
                  {selected.description && (
                    <p className="mt-1 text-muted">{selected.description}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <Button variant="secondary" onClick={() => edit(selected)}>
                    Edit
                  </Button>
                  {/* A built-in role is what the seed wrote and what the
                      permission backfill targets, so it is not offered. */}
                  {!selected.builtIn && (
                    <DeleteButton
                      path={`/api/admin/roles/${selected.id}`}
                      label="role"
                      confirmWord={selected.name}
                      warning={
                        selected.assignmentCount === 0
                          ? 'Nobody holds it.'
                          : `${selected.assignmentCount} ${selected.assignmentCount === 1 ? 'holder loses' : 'holders lose'} every permission it grants.`
                      }
                      onDeleted={() => {
                        toast({ tone: 'success', title: `${selected.name} deleted` });
                        setParams(new URLSearchParams(), { replace: true });
                        reload();
                      }}
                    />
                  )}
                </div>
              </header>

              <Section
                title="People"
                count={selected.holders.length}
                action={
                  usersError ? (
                    <Status tone="neutral">Needs directory.read to grant</Status>
                  ) : usersLoading || granting || grantable(selected, '').length === 0 ? null : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setGranting(true);
                        setGrantee('');
                        setGrantScope('');
                        setProblem(null);
                      }}
                    >
                      Grant to someone
                    </Button>
                  )
                }
              >
                {granting && (
                  <div className="mb-3 flex flex-wrap items-end gap-2 rounded-panel bg-surface p-3">
                    <Select
                      label="Scope"
                      value={grantScope}
                      onChange={(value) => {
                        setGrantScope(value);
                        setGrantee('');
                      }}
                      options={[
                        { value: '', label: 'Everywhere in this tenant' },
                        ...(unitsData?.orgUnits ?? []).map((unit) => ({ value: unit.id, label: unit.name })),
                      ]}
                    />
                    <Select
                      label="Account"
                      value={grantee}
                      onChange={setGrantee}
                      options={[
                        { value: '', label: 'Choose an account' },
                        ...grantable(selected, grantScope).map((u) => ({ value: u.id, label: u.login })),
                      ]}
                    />
                    <Button
                      size="sm"
                      disabled={grantee === '' || busy}
                      loading={busy}
                      onClick={() => void grant(selected)}
                    >
                      Grant
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setGranting(false)}>
                      Cancel
                    </Button>
                  </div>
                )}
                {selected.holders.length === 0 ? (
                  <span className="text-muted">No holders</span>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {selected.holders.map((holder) => (
                      <li
                        // One account can hold the role tenant-wide AND over a unit.
                        key={`${holder.userId}:${holder.scopeOrgUnitId ?? ''}`}
                        className="flex items-center gap-2 rounded-full border border-border-subtle bg-bg py-1 pl-1 pr-1.5"
                      >
                        <span
                          aria-hidden="true"
                          className={[
                            'grid size-7 place-items-center rounded-full text-xs font-semibold',
                            holder.status === 'active' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-muted',
                          ].join(' ')}
                        >
                          {initials(holder)}
                        </span>
                        <span className="text-sm text-ink" title={holder.displayName}>
                          {holder.login}
                        </span>
                        {holder.scopeOrgUnitId !== null && (
                          <Status tone="neutral">{unitNames.get(holder.scopeOrgUnitId) ?? 'scoped'}</Status>
                        )}
                        {holder.status !== 'active' && <Status tone="inactive">cannot sign in</Status>}
                        <button
                          type="button"
                          aria-label={
                            holder.scopeOrgUnitId === null
                              ? `Revoke ${holder.login}`
                              : `Revoke ${holder.login} in ${unitNames.get(holder.scopeOrgUnitId) ?? 'one unit'}`
                          }
                          title="Revoke"
                          onClick={() => void revoke(selected, holder)}
                          className="grid size-6 place-items-center rounded-full text-muted transition-colors duration-150 ease-out-quart hover:bg-danger-soft hover:text-danger"
                        >
                          <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
                            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Permissions" count={selected.permissions.length} of={catalog.length}>
                <PermissionGrid groups={groups} held={new Set(selected.permissions)} />
              </Section>
            </Panel>
          ) : null}
        </div>
      )}
    </>
  );
}

function Section({
  title,
  count,
  of,
  action,
  children,
}: {
  title: string;
  count: number;
  of?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="text-md font-semibold text-ink">
          {title}
          <span className="ml-2 font-normal tabular-nums text-muted">
            {count}
            {of !== undefined && ` of ${of}`}
          </span>
        </h3>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * The catalogue as a grid: one row per module, one chip per permission.
 *
 * Read-only when there is no `onToggle`, and a set of checkboxes drawn as
 * chips when there is -- the same picture in both, so editing a role is
 * changing what was just read rather than learning a second screen.
 */
function PermissionGrid({
  groups,
  held,
  onToggle,
  count,
}: {
  groups: [string, string[]][];
  held: Set<string>;
  onToggle?: (permission: string, on: boolean) => void;
  count?: string;
}) {
  const body = (
    <div className="divide-y divide-border-subtle rounded-panel border border-border-subtle">
      {groups.map(([module, permissions]) => {
        const has = permissions.filter((p) => held.has(p)).length;
        const Row = onToggle ? 'fieldset' : 'div';
        return (
          <Row
            key={module}
            {...(onToggle ? { 'aria-label': module } : {})}
            className="grid gap-2 px-3.5 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center"
          >
            {onToggle ? (
              <legend className="float-left text-sm font-semibold text-ink sm:float-none">
                {title(module)}
                <span className="ml-1.5 font-normal tabular-nums text-muted">
                  {has}/{permissions.length}
                </span>
              </legend>
            ) : (
              <span className="text-sm font-semibold text-ink">
                {title(module)}
                <span className="ml-1.5 font-normal tabular-nums text-muted">
                  {has}/{permissions.length}
                </span>
              </span>
            )}
            <span className="flex flex-wrap gap-1.5">
              {permissions.map((permission) => {
                const on = held.has(permission);
                const chip = [
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm',
                  'transition-colors duration-150 ease-out-quart',
                  on
                    ? 'border-primary/40 bg-primary-soft font-medium text-primary'
                    : 'border-dashed border-border-control text-muted',
                ].join(' ');
                const glyph = on ? (
                  <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
                    <path d="M2.5 6.25 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null;
                return onToggle ? (
                  <label
                    key={permission}
                    title={permission}
                    className={`${chip} cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-2 ${on ? '' : 'hover:border-border-strong hover:text-ink'}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={(e) => onToggle(permission, e.target.checked)}
                      aria-label={permission}
                    />
                    {glyph}
                    {actionOf(permission)}
                  </label>
                ) : (
                  <span key={permission} title={permission} className={chip}>
                    {glyph}
                    <span className="sr-only">{on ? 'Granted: ' : 'Not granted: '}</span>
                    {actionOf(permission)}
                  </span>
                );
              })}
            </span>
          </Row>
        );
      })}
    </div>
  );

  if (!onToggle) return body;
  return (
    <fieldset aria-label="Permissions">
      <legend className="mb-2 flex w-full items-center text-md font-semibold text-ink">
        Permissions
        {count && <span className="ml-2 font-normal tabular-nums text-muted">{count}</span>}
      </legend>
      {body}
    </fieldset>
  );
}
