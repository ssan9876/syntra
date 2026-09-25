import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Empty,
  Field,
  Identifier,
  Panel,
  SkeletonRows,
  StateBadge,
  Status,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
import { ORG_UNITS_ANCHOR } from './target-form.js';

interface TargetRow {
  id: string;
  name: string;
  config: { baseDn?: string } | null;
  /** Whether the target has OUs to place accounts in. Absent from an older API. */
  placesAccountsInContainers?: boolean;
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
 * Where one unit's accounts live, per target -- automatic first, typed DN as
 * the stronger, secondary override.
 *
 * Two ways a unit gets a container, and the panel shows which one each is:
 *
 * - **Mirrored automatically** -- the target has "Mirror org units as OUs" on
 *   and derives the DN from the unit's place in the tree. Shown even before
 *   any run has made it, because "where do these accounts go" has an answer
 *   the moment mirroring is on. No action is needed: the next run records the
 *   placement (`syncMirroredContainers` writes the row) and creates the OU if
 *   it is missing.
 * - **Typed by hand** -- a DN an administrator typed, per target. It is an
 *   OVERRIDE: it always wins over the mirror (that precedence is deliberate
 *   and not changing), so on a mirroring target the first thing offered on a
 *   typed row is "Switch to mirrored".
 *
 * Why automatic comes first. A live tenant materialised every unit by hand,
 * then turned mirroring on, and nothing moved -- every typed DN was still
 * winning, and this panel's most prominent control was the one that typed
 * more of them. So the panel now leads with the automatic answer everywhere:
 * on a mirroring target, the derived DN; on a target that places accounts in
 * OUs but does not mirror, a recommendation to turn mirroring on, linked to
 * the target's Org units section. It is a link and not a button here because
 * the switch belongs to the TARGET and places every unit on it; the target
 * page is where its preview is, and where it is saved (a target PATCH,
 * audited as ever, that writes nothing to the directory).
 *
 * Typing a DN stays one click away, behind "Set a DN by hand", and still
 * pre-fills `OU=<unit>,<parent's container>` when the parent has a container
 * on that target, and `OU=<unit>,<target base>` otherwise. Creating the row is
 * still a separate act from creating the unit: Ruling P9 (revised) rests on a
 * container being created only where somebody asked for one by name.
 *
 * Targets whose connector places no accounts in containers (Entra ID, SCIM)
 * are not offered at all: there is no OU to put the unit in, and the server
 * would refuse it.
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
  /** The target whose "Set a DN by hand" form is open, if any. */
  const [handFor, setHandFor] = useState<string | null>(null);

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
  // Targets with OUs to place the unit in, where it has no placement of any
  // kind: not mirrored, not typed. An older API that does not say whether a
  // target places accounts in containers is taken at its word that it might.
  const unplaced = targets.filter(
    (t) =>
      t.placesAccountsInContainers !== false &&
      !placements.some((c) => c.targetSystemId === t.id),
  );
  const handTarget = handFor === null ? undefined : targets.find((t) => t.id === handFor);
  const handOverridesMirror =
    handFor !== null && placements.some((c) => c.targetSystemId === handFor && c.mirroring);

  const handButton = (targetId: string, overridesMirror: boolean) => (
    <Button size="sm" variant="secondary" onClick={() => setHandFor(targetId)}>
      {overridesMirror ? 'Set a DN by hand (overrides the mirror)' : 'Set a DN by hand'}
    </Button>
  );

  return (
    <Panel title="Containers">
      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      {!data && loading && <SkeletonRows rows={2} cols={2} />}

      {!loading && placements.length === 0 && unplaced.length === 0 && (
        <div className="px-4 pb-4">
          <Empty title="Not in any directory yet">
            None of the targets places accounts in OUs. On one that does, turn on
            &ldquo;Mirror org units as OUs&rdquo; to place every unit by its place in the
            tree.
          </Empty>
        </div>
      )}

      {placements.length > 0 && (
        <ul className="px-4 pb-2">
          {placements.map((c) => {
            const mirroredRow = c.source === 'mirrored';
            const derived = c.state === 'derived';
            return (
              <li
                key={c.targetSystemId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5"
                data-testid={`container-${c.targetSystemId}`}
              >
                <span className="text-muted">{c.targetName}</span>
                {c.dn !== '' && <Identifier value={c.dn} />}
                {mirroredRow && derived && c.mirrored !== false ? (
                  <Status tone="primary">Mirrored automatically</Status>
                ) : mirroredRow && c.mirrored !== false ? (
                  <Status tone="primary">Mirrored</Status>
                ) : mirroredRow && derived ? (
                  <Status tone="warning">Not mirrored</Status>
                ) : mirroredRow ? (
                  <Status tone="neutral">No longer mirrored</Status>
                ) : c.mirroring ? (
                  <Status tone="neutral">Typed by hand (overrides the mirror)</Status>
                ) : (
                  <Status tone="neutral">Typed by hand</Status>
                )}
                {c.dn !== '' && <StateOf row={c} />}
                <span className="ml-auto flex gap-2">
                  {!mirroredRow && c.mirroring && c.derivedDn && (
                    // The PRIMARY action on a typed row of a mirroring target:
                    // the automatic placement is the one this console leads
                    // with, and the typed DN is what stops it applying.
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => switchToMirrored(c.targetSystemId)}
                    >
                      Switch to mirrored
                    </Button>
                  )}
                  {/* A derived placement has no row, so it can still be
                      overridden -- and one the mirror cannot make (a name too
                      long, a DN taken) can only be placed this way. */}
                  {derived && handButton(c.targetSystemId, true)}
                  {/* On a mirroring target a mirrored row comes back on the
                      next run, re-derived and in state 'desired' -- which is
                      the way out when its OU was removed behind Syntra's back
                      and the row is stuck reporting it vanished. Offered, and
                      said. */}
                  {!derived && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => remove(c.targetSystemId)}
                    >
                      Stop tracking
                    </Button>
                  )}
                </span>
                {derived && c.mirrored !== false && (
                  <p className="w-full text-sm text-muted">
                    No action needed: the next run records this placement and creates the OU
                    if it is missing. A DN set by hand would override it.
                  </p>
                )}
                {mirroredRow && c.mirroring && !derived && (
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
                    Typed by hand, and a typed DN always takes precedence over the mirror.
                    Mirrored, it would be <code className="font-mono">{c.derivedDn}</code>.
                    Switching writes nothing to the directory: the next run proposes the
                    move and holds for a person to confirm it.
                  </p>
                )}
                {c.problem && (
                  <p className="w-full text-sm text-muted">
                    Not mirrored: {c.problem}.
                    {!derived && ' The OU stays where it is; nothing is deleted.'}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {unplaced.length > 0 && (
        <ul className="px-4 pb-2">
          {unplaced.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5"
              data-testid={`unplaced-${t.id}`}
            >
              <span className="text-muted">{t.name}</span>
              <Status tone="neutral">Not placed</Status>
              {/* The recommendation first, in reading order as well as on
                  screen; the typed DN after it. */}
              <p className="w-full text-sm text-muted">
                <Link className="link" to={`/admin/targets/${t.id}#${ORG_UNITS_ANCHOR}`}>
                  Turn on mirroring for this target (recommended)
                </Link>{' '}
                to place this unit, and every other, at an OU derived from the org-unit
                tree, with no DN to type. The target page previews what it would build
                before anything is saved. Or set a DN by hand for this target only.
              </p>
              <span className="flex w-full gap-2">{handButton(t.id, false)}</span>
            </li>
          ))}
        </ul>
      )}

      {handFor !== null && handTarget !== undefined && (
        <div className="px-4">
          <RecordPanel
            key={handFor}
            title={
              handOverridesMirror
                ? `Set a DN by hand on ${handTarget.name} (overrides the mirror)`
                : `Set a DN by hand on ${handTarget.name}`
            }
            submitLabel="Save typed DN"
            initial={{ dn: suggested(handFor) }}
            onCancel={() => setHandFor(null)}
            path={`/api/admin/org-units/${unit.id}/containers`}
            onCreated={() => {
              setHandFor(null);
              reload();
            }}
            build={(v) => ({ targetSystemId: handFor, dn: v.dn ?? '' })}
            fields={(v, set, errs) => (
              <>
                <p className="text-sm text-muted sm:col-span-2" data-testid="hand-typed-precedence">
                  {handOverridesMirror
                    ? 'A typed DN takes precedence over the mirror: this unit stops following the org-unit tree on this target until it is switched back to mirrored.'
                    : 'A typed DN places this unit on this target only, and takes precedence over the mirror if mirroring is turned on later.'}{' '}
                  Nothing is written to the directory here; the next run creates the OU.
                </p>
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
        </div>
      )}
    </Panel>
  );
}
