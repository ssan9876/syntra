import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';

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
 *
 * It sits on the unit's record rather than on the list, with every other
 * control that acts on one unit. It fetches its own targets because the record
 * has no other use for them -- the list page, which once owned this panel and
 * loaded them for it, no longer asks for them at all.
 */
export function ContainersPanel({ unit }: { unit: { id: string; name: string } }) {
  const { data, error, loading, reload } = useApiResource<{ containers: ContainerRow[] }>(
    `/api/admin/org-units/${unit.id}/containers`,
  );
  const targetsResource = useApiResource<{ targets: TargetRow[] }>('/api/admin/targets');
  const targets = targetsResource.data?.targets ?? [];
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
    <Panel title="Containers">
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
