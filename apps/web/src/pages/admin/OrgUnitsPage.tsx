import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
import { DeleteButton } from './DeleteButton.js';
import { StatusToggle } from './StatusToggle.js';
import { PageHeader } from './PageHeader.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';

interface OrgUnitRow {
  id: string;
  name: string;
  parentId: string | null;
  status: string;
  statusReason: string | null;
  sourceId: string | null;
}

interface TargetRow {
  id: string;
  name: string;
  config: { baseDn?: string } | null;
}

interface ContainerRow {
  targetSystemId: string;
  targetName: string;
  dn: string;
  state: string;
}

export function OrgUnitsPage() {
  const { data, error, loading, reload } = useApiResource<{ orgUnits: OrgUnitRow[] }>(
    '/api/admin/org-units',
  );
  // Narrowed once, and shared by the summary cards and the table below.
  // A 200 without its collection must render empty, not blank the console.
  const orgUnits = data?.orgUnits ?? [];

  // ONE editor for the page, opened by a row. See the same note on UsersPage.
  const [editing, setEditing] = useState<OrgUnitRow | null>(null);
  // And one container panel, for the same reason.
  const [materialising, setMaterialising] = useState<OrgUnitRow | null>(null);
  const targets = useApiResource<{ targets: TargetRow[] }>('/api/admin/targets');

  // Rendered as a tree rather than a flat list: the hierarchy is the point,
  // and an administrator scoping a role to a unit needs to see what sits
  // beneath it.
  const roots = data?.orgUnits.filter((u) => u.parentId === null) ?? [];
  const childrenOf = (id: string) =>
    data?.orgUnits.filter((u) => u.parentId === id) ?? [];

  return (
    <>
      <PageHeader
        title="Org units"
      />

      <StatGrid>
        <StatCard label="Org units" value={orgUnits.length} />
        <StatCard
          label="From a directory"
          value={orgUnits.filter((u) => u.sourceId !== null).length}
        />
        <StatCard
          label="Inactive"
          value={orgUnits.filter((u) => u.status !== 'active').length}
          tone="warning"
          quietWhenZero
        />
      </StatGrid>

      {error && <Alert tone="danger">{error}</Alert>}

      {materialising && (
        <ContainersPanel
          key={materialising.id}
          unit={materialising}
          targets={targets.data?.targets ?? []}
          onClose={() => setMaterialising(null)}
        />
      )}

      {editing && (
        <RecordPanel
          key={editing.id}
          title={`Edit ${editing.name}`}
          submitLabel="Save"
          method="PATCH"
          path={`/api/admin/org-units/${editing.id}`}
          initial={{ name: editing.name, parentId: editing.parentId ?? '' }}
          onCancel={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
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
                  // cycle is a unit named as its own parent, one click away in
                  // an unfiltered list.
                  ...(data?.orgUnits ?? [])
                    .filter((u) => u.id !== editing.id)
                    .map((u) => ({ value: u.id, label: u.name })),
                ]}
              />
            </>
          )}
        />
      )}

      <RecordPanel
        title="New org unit"
        submitLabel="New org unit"
        path="/api/admin/org-units"
        onCreated={reload}
        build={(v) => ({
          name: v.name ?? '',
          // Empty means top level. `parentId` is a uuid or absent — never an
          // empty string, which the schema rejects as a malformed uuid.
          ...(v.parentId ? { parentId: v.parentId } : {}),
        })}
        fields={(v, set, errs) => (
          <>
            <Field
              label="Name"
              value={v.name ?? ''}
              onChange={(x) => set('name', x)}
              error={errs.name}
              placeholder="Finance"
            />
            <Select
              label="Parent"
              value={v.parentId ?? ''}
              onChange={(x) => set('parentId', x)}
              error={errs.parentId}
              options={[
                { value: '', label: 'No parent — top level' },
                ...(data?.orgUnits ?? []).map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
          </>
        )}
      />

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={4} cols={2} />}

          {!loading && data?.orgUnits.length === 0 && (
            <div className="p-6">
              <Empty title="No org units yet">
                Add a unit such as a department or site to scope administrative
                roles to part of the organization.
              </Empty>
            </div>
          )}

          {!loading && roots.length > 0 && (
            <ul className="p-2">
              {roots.map((unit) => (
                <li key={unit.id}>
                  <Row
                    unit={unit}
                    onEdit={setEditing}
                    onMaterialise={setMaterialising}
                    onChanged={reload}
                    className="font-medium text-ink"
                  />
                  {childrenOf(unit.id).length > 0 && (
                    <ul className="ml-3 border-l border-border-subtle pl-3">
                      {childrenOf(unit.id).map((child) => (
                        <li key={child.id}>
                          <Row
                            unit={child}
                            onEdit={setEditing}
                            onMaterialise={setMaterialising}
                            onChanged={reload}
                            className="text-muted"
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </>
  );
}

/**
 * One unit in the tree, at either depth.
 *
 * Shared rather than written twice because the two levels differ only in
 * their type colour — and the version that was written twice already had the
 * deactivation control on neither.
 */
function Row({
  unit,
  onEdit,
  onMaterialise,
  onChanged,
  className,
}: {
  unit: OrgUnitRow;
  onEdit(unit: OrgUnitRow): void;
  onMaterialise(unit: OrgUnitRow): void;
  onChanged(): void;
  className: string;
}) {
  const can = useCan();

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 rounded-control px-2 py-1.5 transition-colors hover:bg-surface ${className}`}
    >
      <span>{unit.name}</span>
      {unit.status !== 'active' && (
        // LABELLED, not hidden. A deactivated unit keeps its name, its place
        // in the tree and the users sitting in it — an administrator needs to
        // see that it is still there and why it grants nothing.
        <Status tone="inactive">
          {unit.statusReason ? `inactive — ${unit.statusReason}` : 'inactive'}
        </Status>
      )}
      <span className="ml-auto flex items-center gap-2">
        {can(PROVISION_MANAGE) && (
          <Button size="sm" variant="secondary" onClick={() => onMaterialise(unit)}>
            Containers
          </Button>
        )}
        {!unit.sourceId && (
          <Button size="sm" variant="secondary" onClick={() => onEdit(unit)}>
            Edit
          </Button>
        )}
        {unit.sourceId ? (
          // The next sync run reads the unit as present in the directory and
          // puts it back, so the button would appear to work and then quietly
          // undo itself. Saying who owns it is the honest answer — the same
          // one the users page gives for a source-owned account.
          <span className="text-sm text-muted">managed by a directory source</span>
        ) : (
          <StatusToggle
            active={unit.status === 'active'}
            basePath={`/api/admin/org-units/${unit.id}`}
            label="org unit"
            consequences="Users stay where they are. The unit grants nothing — neither its applications nor a role scoped to it."
            onChanged={onChanged}
          />
        )}
        {/* Offered second, and refused by the server unless the unit is
            empty. Deactivating keeps the users where they are; this cannot,
            which is why "move them first" is the server's answer rather than
            a silent reparent. */}
        {can('directory.delete') && (
          <DeleteButton
            path={`/api/admin/org-units/${unit.id}`}
            label="org unit"
            confirmWord={unit.name}
            warning="The unit is removed from the directory and from Syntra. It has to be empty first — a deactivated user still counts as being in it. This cannot be undone."
            onDeleted={onChanged}
          />
        )}
      </span>
    </div>
  );
}

const PROVISION_MANAGE = 'provision.manage';

/**
 * Where one unit's accounts live, per target.
 *
 * Two decisions, two panels: creating a unit in Syntra writes nothing to any
 * directory, and binding it to a container is a separate act. That separation
 * is what Ruling P9 (revised) rests on -- Provision creates a container only
 * where an administrator asked for one by name -- so this must never be folded
 * into the New org unit form.
 *
 * The DN is shown as it is typed and defaults to `OU=<name>,<target base>`.
 * That preview IS the explanation: a control needing a paragraph beside it to
 * be usable is a control that needs redesigning, and "this will create
 * OU=Sales,OU=Users,DC=acme,DC=test" says everything the paragraph would.
 */
function ContainersPanel({
  unit,
  targets,
  onClose,
}: {
  unit: OrgUnitRow;
  targets: TargetRow[];
  onClose(): void;
}) {
  const { data, error, loading, reload } = useApiResource<{ containers: ContainerRow[] }>(
    `/api/admin/org-units/${unit.id}/containers`,
  );
  const [removeError, setRemoveError] = useState<string | null>(null);

  const suggested = (targetId: string) => {
    const base = targets.find((t) => t.id === targetId)?.config?.baseDn ?? '';
    return base === '' ? '' : `OU=${unit.name},${base}`;
  };

  const remove = async (targetSystemId: string) => {
    setRemoveError(null);
    const res = await fetch(
      `/api/admin/org-units/${unit.id}/containers/${targetSystemId}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      // Removing the ROW never touches the container, so there is nothing
      // half-done to describe here.
      setRemoveError('Could not stop tracking this container.');
      return;
    }
    reload();
  };

  const materialised = data?.containers ?? [];
  const remaining = targets.filter(
    (t) => !materialised.some((c) => c.targetSystemId === t.id),
  );

  return (
    <Panel>
      <div className="flex items-center justify-between p-4">
        <h2 className="font-medium text-ink">{unit.name} — containers</h2>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {removeError && <Alert tone="danger">{removeError}</Alert>}

      {loading && <SkeletonRows rows={2} cols={2} />}

      {!loading && materialised.length === 0 && (
        <div className="px-4 pb-4">
          <Empty title="Not in any directory yet">
            Materialise this unit against a target to place its people&apos;s
            accounts in a container there.
          </Empty>
        </div>
      )}

      {materialised.length > 0 && (
        <ul className="px-4 pb-2">
          {materialised.map((c) => (
            <li
              key={c.targetSystemId}
              className="flex flex-wrap items-center gap-x-3 py-1.5"
            >
              <span className="text-muted">{c.targetName}</span>
              <code className="text-ink">{c.dn}</code>
              {/* `desired` means the target has not confirmed it yet, which is
                  the ordinary state before the next run rather than a fault. */}
              <Status tone={c.state === 'desired' ? 'neutral' : 'active'}>
                {c.state}
              </Status>
              <span className="ml-auto">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => remove(c.targetSystemId)}
                >
                  Stop tracking
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {remaining.length > 0 && (
        <RecordPanel
          title="Materialise on a target"
          submitLabel="Create container"
          path={`/api/admin/org-units/${unit.id}/containers`}
          onCreated={reload}
          build={(v) => ({
            targetSystemId: v.targetSystemId ?? '',
            dn: v.dn ?? '',
          })}
          fields={(v, set, errs) => (
            <>
              <Select
                label="Target"
                value={v.targetSystemId ?? ''}
                onChange={(x) => {
                  set('targetSystemId', x);
                  // The suggestion follows the target, because it is built
                  // from that target's base. Filled in only while the field is
                  // untouched, so it never overwrites what somebody typed.
                  if (!v.dn) set('dn', suggested(x));
                }}
                error={errs.targetSystemId}
                options={[
                  { value: '', label: 'Choose a target' },
                  ...remaining.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
              <Field
                label="Container"
                value={v.dn ?? ''}
                onChange={(x) => set('dn', x)}
                error={errs.dn}
                placeholder={`OU=${unit.name},…`}
              />
            </>
          )}
        />
      )}
    </Panel>
  );
}
