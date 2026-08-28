import { Link } from 'react-router-dom';
import { Alert, Empty, Field, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
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

export function OrgUnitsPage() {
  const { data, error, loading, reload } = useApiResource<{ orgUnits: OrgUnitRow[] }>(
    '/api/admin/org-units',
  );
  // Narrowed once, and shared by the summary cards and the table below.
  // A 200 without its collection must render empty, not blank the console.
  const orgUnits = data?.orgUnits ?? [];

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
                  <Row unit={unit} className="font-medium" />
                  {childrenOf(unit.id).length > 0 && (
                    <ul className="ml-3 border-l border-border-subtle pl-3">
                      {childrenOf(unit.id).map((child) => (
                        <li key={child.id}>
                          <Row unit={child} />
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
 * One node of the tree, at either depth.
 *
 * A node in a tree is a row, and a row opens a record: the name is a link, and
 * what stays here is what can be read at a glance. Every control a unit had —
 * edit, deactivate, delete, and the note about the directory that owns it —
 * lived here and now lives on the record, where there is room to say what each
 * one is about to do before it does it.
 *
 * Shared between the two depths rather than written twice, because they differ
 * only in weight; the version that was written twice had the deactivation
 * control on neither.
 */
function Row({ unit, className = '' }: { unit: OrgUnitRow; className?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 rounded-control px-2 py-1.5 transition-colors hover:bg-surface">
      <Link
        to={`/admin/org-units/${unit.id}`}
        className={`text-ink underline-offset-2 hover:text-primary hover:underline ${className}`}
      >
        {unit.name}
      </Link>
      {unit.status !== 'active' && (
        // LABELLED, not hidden. A deactivated unit keeps its name, its place
        // in the tree and the users sitting in it — an administrator needs to
        // see that it is still there and why it grants nothing.
        <Status tone="inactive">
          {unit.statusReason ? `inactive — ${unit.statusReason}` : 'inactive'}
        </Status>
      )}
    </div>
  );
}
