import { useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Field,
  Identifier,
  Panel,
  Select,
  SkeletonRows,
  StateBadge,
  Status,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';

interface TargetRow {
  id: string;
  name: string;
  config: { baseDn?: string } | null;
}

export interface ContainerRow {
  targetSystemId: string;
  targetName: string;
  dn: string;
  /** 'desired' | 'live' | 'adopted', or 'derived' when no row exists yet. */
  state: string;
  /** 'manual' | 'mirrored'. Absent from an older API, which only had manual. */
  source?: string;
  /** A move the next run proposes, from here to `dn`. */
  previousDn?: string | null;
  /** Whether the target mirrors org units at all. */
  mirroring?: boolean;
  /** Whether the mirror keeps this placement in step. */
  mirrored?: boolean;
  derivedDn?: string | null;
  problem?: string | null;
}

/**
 * One RDN value escaped for a distinguished name, per RFC 4514.
 *
 * The console's copy of `escapeDnValue` (`@syntra/core`, which the browser
 * bundle cannot import), used only to PRE-FILL a box somebody then reads and
 * may edit: the server validates whatever is submitted. A unit called
 * `Sales, West` must pre-fill as `OU=Sales\, West,...` or the suggestion is a
 * DN naming a different container than the one it looks like.
 */
export function escapeRdnValue(value: string): string {
  let escaped = value.replace(/[\\",+<>;=\u0000]/g, (character) =>
    character === '\u0000' ? '\\00' : `\\${character}`,
  );
  if (escaped.startsWith('#') || escaped.startsWith(' ')) escaped = `\\${escaped}`;
  if (escaped.endsWith(' ')) escaped = `${escaped.slice(0, -1)}\\ `;
  return escaped;
}

function StateOf({ row }: { row: ContainerRow }) {
  if (row.state === 'derived') {
    return <StateBadge state="pending">The next run creates it</StateBadge>;
  }
  if (row.previousDn) {
    return <StateBadge state="pending">The next run moves it</StateBadge>;
  }
  // `desired` means the target has not confirmed it yet, which is the
  // ordinary state before the next run rather than a fault.
  if (row.state === 'desired') {
    return <StateBadge state="pending">Awaiting the next run</StateBadge>;
  }
  return (
    <StateBadge state="healthy">
      {row.state.charAt(0).toUpperCase() + row.state.slice(1)}
    </StateBadge>
  );
}

/**
 * Where one unit's accounts live, per target.
 *
 * Two ways a unit gets a container, and the panel shows which one each is:
 *
 * - **Materialised** -- a DN an administrator typed, per target. That stays a
 *   separate act from creating the unit: Ruling P9 (revised) rests on a
 *   container being created only where somebody asked for one by name, so it
 *   is never folded into the New org unit form. A typed DN always wins.
 * - **Mirrored** -- the target has "Mirror org units as OUs" on, and derives
 *   the DN from the unit's place in the tree. Shown even before any run has
 *   made it, because "where do these accounts go" has an answer the moment
 *   mirroring is on.
 *
 * The Materialise box pre-fills `OU=<unit>,<parent's container>` when the
 * parent has a container on that target, and `OU=<unit>,<target base>`
 * otherwise. That preview IS the explanation: "this will create
 * OU=Sales,OU=Users,DC=acme,DC=test" says everything a paragraph would.
 */
export function ContainersPanel({
  unit,
}: {
  unit: { id: string; name: string; parentId?: string | null };
}) {
  const { data, error, loading, reload } = useApiResource<{ containers: ContainerRow[] }>(
    `/api/admin/org-units/${unit.id}/containers`,
  );
  const parentId = unit.parentId ?? null;
  const parent = useApiResource<{ containers: ContainerRow[] }>(
    parentId === null ? null : `/api/admin/org-units/${parentId}/containers`,
  );
  const targetsResource = useApiResource<{ targets: TargetRow[] }>('/api/admin/targets');
  const targets = targetsResource.data?.targets ?? [];
  const [actionError, setActionError] = useState<string | null>(null);

  const suggested = (targetId: string) => {
    const own = `OU=${escapeRdnValue(unit.name)}`;
    // The parent's container on THIS target -- its row, or the DN the target
    // mirrors it at -- so a child lands under its parent without anybody
    // retyping the parent's DN.
    const parentDn = parent.data?.containers.find(
      (c) => c.targetSystemId === targetId && c.dn !== '',
    )?.dn;
    if (parentDn) return `${own},${parentDn}`;
    const base = targets.find((t) => t.id === targetId)?.config?.baseDn ?? '';
    return base === '' ? '' : `${own},${base}`;
  };

  const remove = async (targetSystemId: string) => {
    setActionError(null);
    const res = await fetch(
      `/api/admin/org-units/${unit.id}/containers/${targetSystemId}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      // Removing the ROW never touches the container, so there is nothing
      // half-done to describe here.
      setActionError('Could not stop tracking this container.');
      return;
    }
    reload();
  };

  const switchToMirrored = async (targetSystemId: string) => {
    setActionError(null);
    try {
      await api(
        `/api/admin/org-units/${unit.id}/containers/${targetSystemId}/switch-to-mirrored`,
        { method: 'POST' },
      );
      reload();
    } catch (cause) {
      setActionError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title ?? 'Could not switch to mirrored.')
          : 'Could not switch to mirrored.',
      );
    }
  };

  const placements = data?.containers ?? [];
  // A derived placement has no row, so the unit can still be materialised by
  // hand on that target -- and a typed DN wins over the mirror.
  const remaining = targets.filter(
    (t) => !placements.some((c) => c.targetSystemId === t.id && c.state !== 'derived'),
  );

  return (
    <Panel title="Containers">
      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      {!data && loading && <SkeletonRows rows={2} cols={2} />}

      {!loading && placements.length === 0 && (
        <div className="px-4 pb-4">
          <Empty title="Not in any directory yet">
            Materialise this unit against a target to place its people&apos;s
            accounts in a container there, or turn on &ldquo;Mirror org units
            as OUs&rdquo; on the target to place every unit by its place in the
            tree.
          </Empty>
        </div>
      )}

      {placements.length > 0 && (
        <ul className="px-4 pb-2">
          {placements.map((c) => {
            const mirroredRow = c.source === 'mirrored';
            return (
              <li
                key={c.targetSystemId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5"
                data-testid={`container-${c.targetSystemId}`}
              >
                <span className="text-muted">{c.targetName}</span>
                {c.dn !== '' && <Identifier value={c.dn} />}
                {mirroredRow && c.mirrored !== false ? (
                  <Status tone="primary">Mirrored</Status>
                ) : mirroredRow && c.state === 'derived' ? (
                  <Status tone="warning">Not mirrored</Status>
                ) : mirroredRow ? (
                  <Status tone="neutral">No longer mirrored</Status>
                ) : (
                  <Status tone="neutral">Materialised</Status>
                )}
                {c.dn !== '' && <StateOf row={c} />}
                <span className="ml-auto flex gap-2">
                  {!mirroredRow && c.mirroring && c.derivedDn && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => switchToMirrored(c.targetSystemId)}
                    >
                      Switch to mirrored
                    </Button>
                  )}
                  {/* On a mirroring target a mirrored row comes back on the
                      next run, re-derived and in state 'desired' -- which is
                      the way out when its OU was removed behind Syntra's back
                      and the row is stuck reporting it vanished. Offered, and
                      said. */}
                  {c.state !== 'derived' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => remove(c.targetSystemId)}
                    >
                      Stop tracking
                    </Button>
                  )}
                </span>
                {mirroredRow && c.mirroring && c.state !== 'derived' && (
                  <p className="w-full text-sm text-muted">
                    Stop tracking forgets this row, never the OU; the next run derives it
                    again and creates the OU only if it is missing.
                  </p>
                )}
                {c.previousDn && (
                  <p className="w-full text-sm text-muted">
                    Currently at <code className="font-mono">{c.previousDn}</code>. The next
                    run proposes moving that OU, with every account in it, here; a person
                    confirms it before anything moves.
                  </p>
                )}
                {!mirroredRow && c.mirroring && c.derivedDn && (
                  <p className="w-full text-sm text-muted">
                    Materialised by hand, which wins over the mirror. Mirrored, it would be{' '}
                    <code className="font-mono">{c.derivedDn}</code>.
                  </p>
                )}
                {c.problem && (
                  <p className="w-full text-sm text-muted">
                    Not mirrored: {c.problem}.
                    {c.state !== 'derived' && ' The OU stays where it is; nothing is deleted.'}
                  </p>
                )}
              </li>
            );
          })}
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
                  // from that target's base or the parent's container there.
                  // Filled in only while the field is untouched, so it never
                  // overwrites what somebody typed.
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
                name="dn"
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
