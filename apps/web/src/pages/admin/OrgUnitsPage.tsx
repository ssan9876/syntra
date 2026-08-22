import { Alert, Empty, Field, Panel, Select, SkeletonRows } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { CreatePanel } from './CreatePanel.js';
import { PageHeader } from './PageHeader.js';

interface OrgUnitRow {
  id: string;
  name: string;
  parentId: string | null;
}

export function OrgUnitsPage() {
  const { data, error, loading, reload } = useApiResource<{ orgUnits: OrgUnitRow[] }>(
    '/api/admin/org-units',
  );

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

      <CreatePanel
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
                  <div className="rounded-control px-2 py-1.5 font-medium text-ink transition-colors hover:bg-surface">
                    {unit.name}
                  </div>
                  {childrenOf(unit.id).length > 0 && (
                    <ul className="ml-3 border-l border-border-subtle pl-3">
                      {childrenOf(unit.id).map((child) => (
                        <li
                          key={child.id}
                          className="rounded-control px-2 py-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
                        >
                          {child.name}
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
