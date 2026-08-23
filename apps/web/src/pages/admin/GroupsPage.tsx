import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
import { StatusToggle } from './StatusToggle.js';
import { PageHeader } from './PageHeader.js';

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  statusReason: string | null;
  sourceId: string | null;
}

export function GroupsPage() {
  const { data, error, loading, reload } = useApiResource<{ groups: GroupRow[] }>(
    '/api/admin/groups',
  );
  // ONE editor for the whole page, opened by a row. Not one collapsed panel
  // per row: that puts a block-level trigger inside a flex row and, opened, a
  // two-column form inside it.
  const [editing, setEditing] = useState<GroupRow | null>(null);

  return (
    <>
      <PageHeader
        title="Groups"
        description="Collections of users. Access is granted to groups rather than to people one at a time."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {editing && (
        <RecordPanel
          key={editing.id}
          title={`Edit ${editing.name}`}
          submitLabel="Save"
          method="PATCH"
          path={`/api/admin/groups/${editing.id}`}
          initial={{ name: editing.name, description: editing.description ?? '' }}
          onCancel={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
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

      <RecordPanel
        title="New group"
        submitLabel="New group"
        path="/api/admin/groups"
        onCreated={reload}
        build={(v) => ({
          name: v.name ?? '',
          // Omitted rather than sent empty: the schema takes `description` as
          // optional, and an empty string is a description somebody wrote.
          ...(v.description ? { description: v.description } : {}),
        })}
        fields={(v, set, errs) => (
          <>
            <Field
              label="Name"
              value={v.name ?? ''}
              onChange={(x) => set('name', x)}
              error={errs.name}
              placeholder="Ward Nurses"
            />
            <Field
              label="Description"
              value={v.description ?? ''}
              onChange={(x) => set('description', x)}
              error={errs.description}
              hint="What this group is for. Shown wherever the group is granted access."
            />
          </>
        )}
      />

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={4} cols={2} />}

          {!loading && data?.groups.length === 0 && (
            <div className="p-6">
              <Empty title="No groups yet">
                Create a group to grant the same access to several people at
                once instead of repeating it per person.
              </Empty>
            </div>
          )}

          {!loading && data && data.groups.length > 0 && (
            <ul>
              {data.groups.map((group) => (
                <li
                  key={group.id}
                  className="flex flex-wrap items-center gap-x-3 border-b border-border-subtle px-4 py-3 last:border-0 transition-colors hover:bg-surface"
                >
                  <span className="font-medium text-ink">{group.name}</span>
                  {group.description && (
                    <span className="text-muted">{group.description}</span>
                  )}
                  {group.status !== 'active' && (
                    // LABELLED, not hidden. A deactivated group keeps its
                    // members and grants nothing, and an administrator needs
                    // to see that it is still there and why.
                    <Status tone="inactive">
                      {group.statusReason
                        ? `inactive — ${group.statusReason}`
                        : 'inactive'}
                    </Status>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    {!group.sourceId && (
                      // A source-owned group is refused by the API — the next
                      // sync run reads its name out of the directory and would
                      // overwrite the change — so the control is not offered
                      // rather than offered and rejected.
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditing(group)}
                      >
                        Edit
                      </Button>
                    )}
                    <StatusToggle
                      active={group.status === 'active'}
                      basePath={`/api/admin/groups/${group.id}`}
                      label="group"
                      reasonPrompt="Why is this group being deactivated? Its members are kept and it will grant nothing."
                      onChanged={reload}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </>
  );
}
