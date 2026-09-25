import { useEffect, useState } from 'react';
import { Alert, Button, Empty, SkeletonRows, Status } from '@syntra/ui';
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
      return <Status tone="neutral">Typed DN (overrides the mirror)</Status>;
    case 'not_mirrored':
      return <Status tone="neutral">No longer mirrored</Status>;
    default:
      return <Status tone="neutral">{unit.status === 'active' ? 'Would be mirrored' : 'Deactivated'}</Status>;
  }
}

/** What `POST /targets/:id/org-units/switch-to-mirrored` answers. */
export interface SwitchAllResponse {
  targetSystemId: string;
  switched: { orgUnitId: string; unitName: string; from: string; dn: string; pendingMoveFrom: string | null }[];
  skipped: { orgUnitId: string; unitName: string; dn: string; reason: string; message: string }[];
}

const problemText = (cause: unknown, fallback: string) =>
  cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title ?? fallback) : fallback;

/**
 * "Mirroring is on, but these units still use a DN typed by hand."
 *
 * Why this is a warning and not a footnote: a tenant that materialised its
 * units by hand and then turned mirroring on sees NOTHING move -- a typed DN
 * always wins over the mirror, deliberately, and that rule is not changing.
 * Without this the console said so only as a grey note on each row of the
 * preview, and the administrator who reported it read the checkbox, saved,
 * ran, and concluded mirroring did not work.
 *
 * Each unit is listed with the DN that is in force and the DN mirroring would
 * give it, so the choice is made looking at both. "Switch all to mirrored"
 * converts every one of them in one audited transaction; the per-unit buttons
 * are for the administrator who means to keep some typed DNs on purpose.
 *
 * Buttons are `type="button"`: this renders inside the target form, and a
 * default-typed button there would submit (and save) the whole target.
 *
 * Offered only against the SAVED setting and root. The bulk switch derives
 * from what is stored, so with an unsaved root in the box the DNs shown here
 * are not the ones it would write -- the buttons say to save first instead.
 */
function HandTypedWarning({
  targetId,
  units,
  unsaved,
  onChanged,
}: {
  targetId: string;
  units: MirrorPreviewUnit[];
  unsaved: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<SwitchAllResponse | null>(null);

  const switchAll = async () => {
    setBusy('all');
    setFailure(null);
    setResult(null);
    try {
      const body = await api<SwitchAllResponse>(`/api/admin/targets/${targetId}/org-units/switch-to-mirrored`, {
        method: 'POST',
      });
      setResult(body);
      onChanged();
    } catch (cause) {
      setFailure(problemText(cause, 'Could not switch these units to mirrored.'));
    } finally {
      setBusy(null);
    }
  };

  const switchOne = async (unit: MirrorPreviewUnit) => {
    setBusy(unit.id);
    setFailure(null);
    setResult(null);
    try {
      const body = await api<{ dn: string; pendingMoveFrom: string | null }>(
        `/api/admin/org-units/${unit.id}/containers/${targetId}/switch-to-mirrored`,
        { method: 'POST' },
      );
      setResult({
        targetSystemId: targetId,
        switched: [{ orgUnitId: unit.id, unitName: unit.name, from: unit.row?.dn ?? '', dn: body.dn, pendingMoveFrom: body.pendingMoveFrom }],
        skipped: [],
      });
      onChanged();
    } catch (cause) {
      setFailure(problemText(cause, `Could not switch ${unit.name} to mirrored.`));
    } finally {
      setBusy(null);
    }
  };

  const outcome = result !== null && (
    <Alert tone={result.skipped.length > 0 ? 'warning' : 'success'} title={switchedTitle(result)}>
      <p className="text-sm">
        {result.switched.some((s) => s.pendingMoveFrom !== null)
          ? `Nothing has moved in the directory yet. The next run proposes moving ${movesText(result)}, with every account inside, and holds for a person to confirm before anything moves.`
          : 'Nothing is written to the directory here; the next run places these units at their mirrored OUs.'}
      </p>
      {result.skipped.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm" data-testid="switch-all-skipped">
          {result.skipped.map((s) => (
            <li key={s.orgUnitId}>
              {s.unitName} kept its typed DN: {s.message}.
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );

  if (units.length === 0) return outcome || null;

  const count = units.length;
  return (
    <div className="space-y-2">
      {outcome}
      <Alert tone="warning" title={`Mirroring is on, but ${count} org unit${count === 1 ? ' uses' : 's use'} a DN typed by hand`}>
        <div data-testid="hand-typed-warning" className="space-y-2">
          <p className="text-sm">
            A typed DN always wins over the mirror, so {count === 1 ? 'this unit stays' : 'these units stay'} where{' '}
            {count === 1 ? 'it was' : 'they were'} typed until switched. Switching writes nothing to the directory: the next run
            proposes moving each OU, with the accounts in it, to its mirrored place, and a container move always holds the run
            for a person to confirm.
          </p>
          <ul className="space-y-2">
            {units.map((unit) => (
              <li key={unit.id} className="text-sm" data-testid={`hand-typed-${unit.id}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{unit.name}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={unsaved || busy !== null || unit.derivedDn === null || unit.problem !== null}
                    loading={busy === unit.id}
                    onClick={() => switchOne(unit)}
                  >
                    Switch {unit.name}
                  </Button>
                </div>
                <p>
                  Typed: <code className="font-mono break-all">{unit.row?.dn}</code>
                </p>
                <p>
                  {unit.derivedDn !== null && unit.problem === null ? (
                    <>
                      Mirrored: <code className="font-mono break-all">{unit.derivedDn}</code>
                    </>
                  ) : (
                    <>Cannot be mirrored: {unit.problem?.message ?? 'no DN can be derived for it'}.</>
                  )}
                </p>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="primary"
              disabled={unsaved || busy !== null}
              loading={busy === 'all'}
              onClick={switchAll}
            >
              Switch all to mirrored
            </Button>
            {unsaved && <span className="text-sm">Save the org-unit settings first: switching uses the saved root.</span>}
          </div>
          {failure !== null && <p className="text-sm">{failure}</p>}
        </div>
      </Alert>
    </div>
  );
}

function switchedTitle(result: SwitchAllResponse): string {
  const n = result.switched.length;
  if (n === 0) return 'No unit was switched';
  return `Switched ${n} org unit${n === 1 ? '' : 's'} to mirrored`;
}

function movesText(result: SwitchAllResponse): string {
  const n = result.switched.filter((s) => s.pendingMoveFrom !== null).length;
  return n === 1 ? '1 OU' : `${n} OUs`;
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
 * saved. `unsaved` says the mirror settings in the form differ from what is
 * stored, which is what the hand-typed warning's buttons act on.
 */
export function OrgUnitMirrorPreview({
  targetId,
  rootDn,
  unsaved = false,
}: {
  targetId: string;
  rootDn: string;
  unsaved?: boolean;
}) {
  const [preview, setPreview] = useState<MirrorPreviewResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Bumped after a switch, so the tree re-reads what is now stored. */
  const [version, setVersion] = useState(0);

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
  }, [targetId, rootDn, version]);

  if (problem !== null) return <Alert tone="danger">{problem}</Alert>;
  if (preview === null) return loading ? <SkeletonRows rows={3} cols={2} /> : null;

  const units = treeOrder(preview.units);
  // Only while mirroring is on as SAVED (`preview.mirrorOrgUnits` is the
  // stored flag), and only active units: a deactivated unit is not mirrored
  // at all, so its typed row is not something to switch.
  const handTyped =
    preview.mirrorOrgUnits && preview.placesAccountsInContainers
      ? units.filter((unit) => unit.placement === 'manual' && unit.status === 'active')
      : [];
  return (
    <div className="space-y-2" data-testid="org-unit-mirror-preview">
      <HandTypedWarning
        targetId={targetId}
        units={handTyped}
        unsaved={unsaved}
        onChanged={() => setVersion((v) => v + 1)}
      />
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
