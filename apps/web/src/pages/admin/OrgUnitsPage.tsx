import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
import { StatusToggle } from './StatusToggle.js';
import { PageHeader } from './PageHeader.js';

interface OrgUnitRow {
  id: string;
  name: string;
  parentId: string | null;
  status: string;
  statusReason: string | null;
  sourceId: string | null;
}

export function OrgUnitsPage() {
  const { data, error, loading, reload } = useApiResource<{ orgUnits: OrgUnitRow[] }>(
    '/api/admin/org-units',
  );
  // ONE editor for the page, opened by a row. See the same note on UsersPage.
  const [editing, setEditing] = useState<OrgUnitRow | null>(null);

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
        description="The organizational hierarchy. Administrative roles can be scoped to a single unit."
      />

      {error && <Alert tone="danger">{error}</Alert>}

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
                hint="A unit cannot be moved inside itself or anything below it."
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
              hint="Leave at the top level for a unit with no parent."
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
  onChanged,
  className,
}: {
  unit: OrgUnitRow;
  onEdit(unit: OrgUnitRow): void;
  onChanged(): void;
  className: string;
}) {
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
            reasonPrompt="Why is this unit being deactivated? The users in it stay where they are, and it will grant nothing — neither its applications nor a role scoped to it."
            onChanged={onChanged}
          />
        )}
      </span>
    </div>
  );
}
