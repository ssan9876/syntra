import { splitDn } from '@syntra/connectors';

/**
 * What a run does to the container STRUCTURE of a target, decided from the
 * `OrgUnitContainer` rows and the containers the target actually holds.
 *
 * Pure: no clock, no database, no I/O. `reconcile` calls it once per run and
 * `planActions` turns its answer into `create_container` and `move_container`
 * actions. It lives in a module of its own because both of them, and the
 * console's preview of a mirrored tree, need the same two answers -- "where
 * will this DN be once this run's moves land" and "in what order must these
 * containers be made" -- and a second copy of either is how the plan and the
 * preview come to disagree about a domain controller.
 */

/** One `OrgUnitContainer` row, as the run reads it. */
export interface ContainerRowFacts {
  id: string;
  /** 'desired' | 'live' | 'adopted' */
  state: string;
  dn: string;
  /**
   * 'manual' | 'mirrored'. Absent means 'manual', which is what every row
   * written before mirroring existed is.
   */
  source?: string;
  /**
   * The DN the target last confirmed, when `dn` has changed since. Absent or
   * null when nothing is pending.
   */
  previousDn?: string | null;
}

export interface ContainerMove {
  orgUnitContainerId: string;
  /** Where the container is at the moment this move is applied. */
  fromDn: string;
  toDn: string;
  /**
   * Rows whose own DN changed ONLY because this container moved -- the
   * children of a renamed unit. They need no action of their own: modifyDN
   * moves the whole subtree, and the apply settles their rows with this one.
   */
  riderIds: string[];
}

export interface ContainerStructure {
  /** Row-backed creates, keyed by row id, in the case the row holds. */
  creates: Map<string, string>;
  /**
   * Containers created for no row of their own: the missing ancestors of a
   * MIRRORED container -- the mirror's root, or the OU of a deactivated unit
   * whose active children still sit under it. Never for a manual row, whose
   * missing parent stays `not_found` (Ruling P9, revised: one typo must not
   * become three containers).
   */
  intermediates: string[];
  moves: ContainerMove[];
  /**
   * Every DN, lowercased, that this run's structure changes will bring into
   * existence. A person whose container is in here stays in the run: the
   * container is coming.
   */
  incoming: Set<string>;
}

const lower = (dn: string) => dn.trim().toLowerCase();

/** The number of RDNs in a DN, on unescaped commas. `''` has none. */
export function dnDepth(dn: string): number {
  let depth = 0;
  let rest = dn.trim();
  while (rest !== '') {
    depth += 1;
    rest = splitDn(rest).parent.trim();
  }
  return depth;
}

/**
 * Where `dn` sits once `moves` have been applied, in order.
 *
 * A container moved takes its subtree with it, so a DN AT or BELOW a moved
 * container is rewritten onto the destination; anything else is untouched.
 * The comparison is on an RDN boundary (`,` + the source), never a bare
 * suffix, for the reason `validateContainerDn` gives: `OU=XIT,...` is not
 * below `OU=IT,...`.
 */
export function rebaseDn(
  dn: string,
  moves: readonly { fromDn: string; toDn: string }[],
): string {
  let current = dn.trim();
  for (const move of moves) {
    const from = lower(move.fromDn);
    const at = current.toLowerCase();
    if (at === from) {
      current = move.toDn.trim();
    } else if (at.endsWith(`,${from}`)) {
      current = `${current.slice(0, current.length - move.fromDn.trim().length)}${move.toDn.trim()}`;
    }
  }
  return current;
}

/**
 * The container structure a run must change.
 *
 * **Moves first.** A row whose `previousDn` the target still holds, and whose
 * new `dn` it does not, is a move. Candidates are taken shallowest first and
 * each is rewritten through the moves already decided, so when a unit and its
 * children were all re-derived by one rename, only the unit moves: its
 * children's previous DNs rebase onto their new ones and ride along. A
 * `previousDn` the target no longer holds is not a move -- the OU was removed
 * behind Syntra's back, and that is `container_vanished`, reported by the
 * person loop, never a silent re-create.
 *
 * **Then creates**, from rows in state 'desired' only (Ruling P9, revised),
 * exactly as before.
 *
 * **Then missing ancestors, for mirrored rows only.** A mirrored tree's
 * intermediate OUs are part of what the target was told to mirror, so
 * `OU=IT,OU=ssander.local,OU=Syntra,DC=...` is creatable when neither parent
 * exists yet. The walk stops at the target's base DN, never creates it or
 * anything above it, and never creates an ancestor whose RDN is not an `OU=`
 * -- a `CN=` container is not something an organizationalUnit create can
 * make, and pretending otherwise fails at the directory one round trip later.
 */
export function planContainerStructure(input: {
  rows: readonly ContainerRowFacts[];
  /** Containers the target holds. Folded here whatever case the caller used. */
  existing: ReadonlySet<string>;
  /** The target's base DN. Empty means no ancestor is ever created. */
  baseDn: string;
}): ContainerStructure {
  const existing = new Set([...input.existing].map(lower));
  const creates = new Map<string, string>();
  const moves: ContainerMove[] = [];
  const incoming = new Set<string>();
  const handled = new Set<string>();

  const candidates = input.rows
    .filter(
      (row) =>
        typeof row.previousDn === 'string' &&
        row.previousDn.trim() !== '' &&
        !existing.has(lower(row.dn)),
    )
    .sort(
      (a, b) =>
        dnDepth(a.previousDn!) - dnDepth(b.previousDn!) ||
        lower(a.previousDn!).localeCompare(lower(b.previousDn!)) ||
        a.id.localeCompare(b.id),
    );

  for (const row of candidates) {
    const previous = row.previousDn!.trim();
    if (!existing.has(lower(previous))) continue;
    const from = rebaseDn(previous, moves);
    if (lower(from) === lower(row.dn)) {
      // Carried by a move already decided. Find which -- the LAST one that
      // rewrote it, since a grandparent and a parent can both move -- so that
      // move's apply settles this row too.
      let carrier: ContainerMove | undefined;
      let traced = previous;
      for (const move of moves) {
        const next = rebaseDn(traced, [move]);
        if (next !== traced) carrier = move;
        traced = next;
      }
      carrier?.riderIds.push(row.id);
      handled.add(row.id);
      incoming.add(lower(row.dn));
      continue;
    }
    moves.push({ orgUnitContainerId: row.id, fromDn: from, toDn: row.dn.trim(), riderIds: [] });
    handled.add(row.id);
    incoming.add(lower(row.dn));
  }

  for (const row of input.rows) {
    if (handled.has(row.id)) continue;
    if (row.state !== 'desired') continue;
    if (existing.has(lower(row.dn))) continue;
    creates.set(row.id, row.dn);
    incoming.add(lower(row.dn));
  }

  // What the target will hold once the moves and creates land: every
  // existing container carried through the moves, plus everything incoming.
  const after = new Set<string>([
    ...[...existing].map((dn) => lower(rebaseDn(dn, moves))),
    ...incoming,
  ]);
  const base = lower(input.baseDn);
  const baseDepth = dnDepth(input.baseDn);
  const intermediates: string[] = [];
  if (base !== '') {
    const mirroredTargets = input.rows
      .filter((row) => row.source === 'mirrored' && incoming.has(lower(row.dn)))
      .map((row) => row.dn.trim());
    for (const target of mirroredTargets) {
      // Not below the base at all: nothing here may be created.
      if (!lower(target).endsWith(`,${base}`)) continue;
      const missing: string[] = [];
      let parent = splitDn(target).parent.trim();
      while (parent !== '' && dnDepth(parent) > baseDepth && lower(parent) !== base) {
        if (after.has(lower(parent))) break;
        if (!/^ou=/i.test(splitDn(parent).rdn.trim())) {
          // A missing CN= ancestor: stop, and let the create fail
          // `not_found` where somebody can read why.
          missing.length = 0;
          break;
        }
        missing.push(parent);
        parent = splitDn(parent).parent.trim();
      }
      for (const dn of missing) {
        after.add(lower(dn));
        incoming.add(lower(dn));
        intermediates.push(dn);
      }
    }
  }

  return { creates, intermediates, moves, incoming };
}
