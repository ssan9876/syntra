import { useEffect, useState } from 'react';
import { Alert, Empty, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

export interface MirrorPreviewUnit {
  id: string;
  name: string;
  parentId: string | null;
  status: string;
  depth: number;
  derivedDn: string | null;
  row: { dn: string; source: string; state: string; previousDn: string | null } | null;
  effectiveDn: string | null;
  placement: 'mirrored' | 'manual' | 'not_mirrored' | 'unplaced';
  problem: { kind: string; message: string } | null;
  note: string | null;
}

export interface MirrorPreviewResponse {
  mirrorOrgUnits: boolean;
  placesAccountsInContainers: boolean;
  baseDn: string;
  rootDn: string | null;
  rootProblem: string | null;
  units: MirrorPreviewUnit[];
}

/** Long enough that typing a root does not fire a request per keystroke. */
const DEBOUNCE_MS = 400;

/**
 * The units in tree order: every parent before its children, siblings by
 * name. The API returns them flat; the preview is only readable as a tree.
 */
export function treeOrder(units: readonly MirrorPreviewUnit[]): MirrorPreviewUnit[] {
  const ids = new Set(units.map((u) => u.id));
  const children = new Map<string | null, MirrorPreviewUnit[]>();
  for (const unit of units) {
    const key = unit.parentId !== null && ids.has(unit.parentId) ? unit.parentId : null;
    children.set(key, [...(children.get(key) ?? []), unit]);
  }
  const ordered: MirrorPreviewUnit[] = [];
  const seen = new Set<string>();
  const walk = (key: string | null) => {
    const list = [...(children.get(key) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const unit of list) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      ordered.push(unit);
      walk(unit.id);
    }
  };
  walk(null);
  // A cycle has no root to be reached from; shown anyway, at the end.
  for (const unit of units) if (!seen.has(unit.id)) ordered.push(unit);
  return ordered;
}

function Placement({ unit }: { unit: MirrorPreviewUnit }) {
  if (unit.problem !== null && unit.placement !== 'manual') {
    return <Status tone="warning">Cannot be mirrored</Status>;
  }
  switch (unit.placement) {
    case 'mirrored':
      return <Status tone="primary">Mirrored</Status>;
    case 'manual':
      return <Status tone="neutral">Materialised by hand</Status>;
    case 'not_mirrored':
      return <Status tone="neutral">No longer mirrored</Status>;
    default:
      return <Status tone="neutral">{unit.status === 'active' ? 'Would be mirrored' : 'Deactivated'}</Status>;
  }
}

/**
 * A read-only tree -> DN preview from the tenant's real org units.
 *
 * Shown whether or not mirroring is on, because the moment somebody decides to
 * turn it on is the moment they need to see what it would build -- and a
 * preview that only appears after the switch is thrown is a preview of a
 * decision already taken. It reads Syntra only; the directory is not asked.
 *
 * `rootDn` is the root as TYPED, so the preview follows the box before it is
 * saved.
 */
export function OrgUnitMirrorPreview({ targetId, rootDn }: { targetId: string; rootDn: string }) {
  const [preview, setPreview] = useState<MirrorPreviewResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      const query = `?rootDn=${encodeURIComponent(rootDn.trim())}`;
      api<MirrorPreviewResponse>(`/api/admin/targets/${targetId}/org-unit-mirror${query}`)
        .then((body) => {
          if (cancelled) return;
          setPreview(body);
          setProblem(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setProblem(
            cause instanceof ApiError
              ? (cause.problem.detail ?? cause.problem.title ?? 'The preview could not be read.')
              : 'The preview could not be read.',
          );
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [targetId, rootDn]);

  if (problem !== null) return <Alert tone="danger">{problem}</Alert>;
  if (preview === null) return loading ? <SkeletonRows rows={3} cols={2} /> : null;

  const units = treeOrder(preview.units);
  return (
    <div className="space-y-2" data-testid="org-unit-mirror-preview">
      {preview.rootProblem !== null ? (
        <Alert tone="warning" title="This root cannot be used">
          {preview.rootProblem}
        </Alert>
      ) : (
        <p className="text-sm text-muted">
          Hangs under <code className="font-mono">{preview.rootDn}</code>.
        </p>
      )}
      {units.length === 0 ? (
        <Empty title="No org units yet">
          Create org units in Syntra and they appear here with the OU each would become.
        </Empty>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-control border border-border-subtle">
          {units.map((unit) => (
            <li
              key={unit.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              style={{ paddingLeft: `${0.75 + unit.depth * 1.25}rem` }}
              data-testid={`mirror-unit-${unit.id}`}
            >
              <span className="font-medium text-ink">{unit.name}</span>
              <Placement unit={unit} />
              {unit.effectiveDn !== null ? (
                <code className="font-mono text-sm text-muted break-all">{unit.effectiveDn}</code>
              ) : unit.derivedDn !== null ? (
                <code className="font-mono text-sm text-muted break-all">{unit.derivedDn}</code>
              ) : null}
              {(unit.problem !== null || unit.note !== null) && (
                <p className="w-full text-sm text-muted">
                  {unit.problem !== null ? unit.problem.message : unit.note}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
