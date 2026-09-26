import { targetConnectorFor } from '@syntra/connectors';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { validateContainerDn } from './org-unit-container-service.js';
import { escapeDnValue } from './templates.js';

/**
 * "Mirror org units as OUs": a target setting that derives every active org
 * unit's container from its place in the tree, instead of from a DN somebody
 * typed per unit.
 *
 * **Where the derived placement lives, and why it is a row.** The placement
 * ladder in `desired.ts` (override -> org-unit container -> template ->
 * fallback) already has a rung for "this person's unit, on this target", and
 * everything downstream of it -- Ruling P9's "a container is created only from
 * a row", the create/adopt/vanish states, the anchor recorded on create, the
 * `container_vanished` finding -- is keyed on an `OrgUnitContainer` row. So a
 * mirrored placement IS a row, with `source = 'mirrored'`, and the ladder,
 * reconcile and apply need no second path beside it.
 *
 * The alternative was to compute derived DNs in memory on every run and feed
 * them to the ladder as if they were rows. It was rejected because the two
 * things a row holds that a computation cannot are exactly the ones mirroring
 * needs: the ANCHOR of an OU Syntra created, and the DN the target last
 * CONFIRMED (`previousDn`) -- without which a renamed unit is indistinguishable
 * from a new one, and the only possible answer is a second OU with the first
 * left behind.
 *
 * **When the rows are kept in step.** Once per run, in
 * {@link syncMirroredContainers}, just after the run has read the target's
 * containers and just before it reads the rows -- not on every org-unit
 * create, rename, move and (de)activation. Org units arrive from the console,
 * from the org-unit API AND from Directory Sync's bulk ingestion; a hook on
 * each of those writers is a hook somebody forgets on the fourth, and a run
 * that re-derives from the tree it is about to act on cannot be out of date.
 * The console, which needs an answer before any run, derives the same DN on
 * read with the same pure function ({@link deriveMirroredDns}).
 *
 * Rows only ever describe INTENT. The directory is written by a run, under the
 * guard, and nowhere else: turning mirroring on writes nothing to any target.
 */

/**
 * Active Directory's `ou` attribute has a range upper of 64 characters. A
 * longer name is refused by the directory on create, one round trip after it
 * could have been refused here -- and truncating it silently would create an
 * OU nobody can recognise, and two units whose names share 64 characters
 * would collide in it.
 */
export const AD_OU_NAME_MAX_LENGTH = 64;

export interface MirrorUnitFacts {
  id: string;
  name: string;
  parentId: string | null;
  /** 'active' | 'inactive'. Only active units are mirrored. */
  status: string;
}

export type MirrorProblemKind =
  | 'name_blank'
  | 'name_too_long'
  | 'cycle'
  | 'duplicate_dn'
  | 'ancestor_problem'
  | 'dn_taken'
  | 'root_invalid';

export interface MirrorProblem {
  orgUnitId: string;
  unitName: string;
  kind: MirrorProblemKind;
  message: string;
}

export interface MirrorDerivation {
  /** Active unit id -> its derived DN. Units with a problem are absent. */
  dns: Map<string, string>;
  /** One per active unit that cannot be mirrored, naming why. */
  problems: MirrorProblem[];
}

type Resolved = { ok: true; dn: string } | { ok: false; kind: MirrorProblemKind; message: string };

/**
 * Every active unit's mirrored DN: `OU=<unit>,OU=<parent>,...,<rootDn>`, the
 * top-level unit nearest the root.
 *
 * Each name is escaped with `escapeDnValue` -- the helper `renderContainer`
 * uses (Ruling P22). An org unit called `Sales, West` is otherwise a valid DN
 * naming a unit called `Sales` below a container called ` West`, placed where
 * nobody chose.
 *
 * An inactive ancestor still contributes its name: deactivating a department
 * does not move the ones beneath it, exactly as it does not in Syntra's own
 * tree. A unit that cannot be derived is a PROBLEM, per unit, by name -- never
 * a truncation, never a silent skip -- and so is every unit beneath it, since
 * its own DN would hang under the one that could not be made.
 *
 * Two active units deriving the same DN (two `IT`s under one parent) are both
 * problems, with their descendants: merging two departments' accounts into
 * one OU is the failure the `[targetSystemId, dn]` unique index exists to
 * prevent, and choosing one of them would be choosing silently.
 *
 * Pure: no clock, no database, no I/O.
 */
export function deriveMirroredDns(
  units: readonly MirrorUnitFacts[],
  rootDn: string,
): MirrorDerivation {
  const root = rootDn.trim();
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const memo = new Map<string, Resolved>();

  const resolve = (id: string, visiting: Set<string>): Resolved => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const unit = byId.get(id)!;
    let result: Resolved;
    if (visiting.has(id)) {
      result = {
        ok: false,
        kind: 'cycle',
        message: `${unit.name} is its own ancestor in the org-unit tree, so it has no path to mirror`,
      };
      memo.set(id, result);
      return result;
    }
    visiting.add(id);
    if (unit.name.trim() === '') {
      result = { ok: false, kind: 'name_blank', message: 'this unit has no name to use as an OU name' };
    } else if ([...unit.name].length > AD_OU_NAME_MAX_LENGTH) {
      result = {
        ok: false,
        kind: 'name_too_long',
        message: `"${unit.name}" is ${[...unit.name].length} characters, and Active Directory limits an OU name to ${AD_OU_NAME_MAX_LENGTH}; rename the unit to mirror it (it is never truncated)`,
      };
    } else if (root === '') {
      result = {
        ok: false,
        kind: 'root_invalid',
        message: 'this target has no base DN or org-unit root to mirror the tree under',
      };
    } else {
      const parent = unit.parentId === null ? undefined : byId.get(unit.parentId);
      const own = `OU=${escapeDnValue(unit.name)}`;
      if (parent === undefined) {
        result = { ok: true, dn: `${own},${root}` };
      } else {
        const above = resolve(parent.id, visiting);
        result = above.ok
          ? { ok: true, dn: `${own},${above.dn}` }
          : above.kind === 'cycle'
            ? above
            : {
                ok: false,
                kind: 'ancestor_problem',
                message: `its parent "${parent.name}" cannot be mirrored: ${above.message}`,
              };
      }
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };

  const dns = new Map<string, string>();
  const problems: MirrorProblem[] = [];
  const active = units.filter((unit) => unit.status === 'active');
  for (const unit of active) {
    const resolved = resolve(unit.id, new Set());
    if (resolved.ok) dns.set(unit.id, resolved.dn);
    else problems.push({ orgUnitId: unit.id, unitName: unit.name, kind: resolved.kind, message: resolved.message });
  }

  // Collisions, case-insensitively, because the directory compares that way.
  const byDn = new Map<string, string[]>();
  for (const [id, dn] of dns) {
    const key = dn.toLowerCase();
    byDn.set(key, [...(byDn.get(key) ?? []), id]);
  }
  const colliding = new Set<string>();
  for (const ids of byDn.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) colliding.add(id);
  }
  if (colliding.size > 0) {
    const underColliding = (id: string): string | null => {
      const seen = new Set<string>();
      let parentId = byId.get(id)?.parentId ?? null;
      while (parentId !== null && !seen.has(parentId)) {
        if (colliding.has(parentId)) return parentId;
        seen.add(parentId);
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return null;
    };
    for (const unit of active) {
      if (!dns.has(unit.id)) continue;
      if (colliding.has(unit.id)) {
        problems.push({
          orgUnitId: unit.id,
          unitName: unit.name,
          kind: 'duplicate_dn',
          message: `another active unit with the same name under the same parent derives the same OU, ${dns.get(unit.id)}; rename one of them to mirror either`,
        });
        continue;
      }
      const ancestor = underColliding(unit.id);
      if (ancestor !== null) {
        problems.push({
          orgUnitId: unit.id,
          unitName: unit.name,
          kind: 'ancestor_problem',
          message: `its ancestor "${byId.get(ancestor)!.name}" shares its OU with another unit, so this unit's OU would too`,
        });
      }
    }
    for (const problem of problems) dns.delete(problem.orgUnitId);
  }

  return { dns, problems };
}

/** Whether a target places accounts in containers, as its connector declares. */
export function targetPlacesAccountsInContainers(type: string, config: unknown): boolean {
  try {
    return targetConnectorFor(type).placesAccountsInContainers(config as never);
  } catch {
    // An unknown type has no connector to ask; the answer that offers
    // nothing is "no".
    return false;
  }
}

export interface MirrorTargetFacts {
  id: string;
  type: string;
  config: unknown;
  mirrorOrgUnits: boolean;
  orgUnitRootDn: string | null;
}

export const baseDnOf = (config: unknown): string => {
  const value = (config as { baseDn?: unknown } | null)?.baseDn;
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Where the mirrored tree hangs on this target, validated, or a refusal.
 *
 * Validated on every read as well as on write, because the base DN it must sit
 * below lives in the connector configuration and can change after the root was
 * saved.
 */
export function mirrorRootFor(
  target: Pick<MirrorTargetFacts, 'config' | 'orgUnitRootDn'>,
): { ok: true; dn: string } | { ok: false; message: string } {
  const base = baseDnOf(target.config);
  const root = target.orgUnitRootDn?.trim() || base;
  const validated = validateContainerDn(root, base);
  return validated.ok ? { ok: true, dn: validated.dn } : { ok: false, message: validated.message };
}

/** Whether this target mirrors, all things considered. */
export function targetMirrors(target: MirrorTargetFacts): boolean {
  return target.mirrorOrgUnits && targetPlacesAccountsInContainers(target.type, target.config);
}

/** The tree, as the derivation needs it. */
export async function mirrorUnits(tx: TenantClient): Promise<MirrorUnitFacts[]> {
  return tx.orgUnit.findMany({
    select: { id: true, name: true, parentId: true, status: true },
    orderBy: { id: 'asc' },
  });
}

/** The derivation for one target, including a root that no longer validates. */
export function deriveForTarget(
  target: MirrorTargetFacts,
  units: readonly MirrorUnitFacts[],
): MirrorDerivation & { rootDn: string | null; rootProblem: string | null } {
  const root = mirrorRootFor(target);
  if (!root.ok) {
    return {
      rootDn: null,
      rootProblem: root.message,
      dns: new Map(),
      problems: units
        .filter((unit) => unit.status === 'active')
        .map((unit) => ({
          orgUnitId: unit.id,
          unitName: unit.name,
          kind: 'root_invalid' as const,
          message: `the target's org-unit root is not usable: ${root.message}`,
        })),
    };
  }
  return { ...deriveMirroredDns(units, root.dn), rootDn: root.dn, rootProblem: null };
}

export interface MirrorSyncReport {
  created: { orgUnitId: string; dn: string }[];
  redirected: { orgUnitId: string; from: string; to: string; pendingMoveFrom: string | null }[];
  /** Rows the target has since confirmed: adopted, or a move that landed. */
  settled: { orgUnitId: string; dn: string }[];
  /**
   * An OU still at a row's previous DN when its new DN already exists --
   * somebody made the new one by hand. Accounts move to the new one one by
   * one; the old OU is left where it is, never deleted, and named here.
   */
  leftBehind: { orgUnitId: string; dn: string }[];
  problems: MirrorProblem[];
}

interface RowFacts {
  id: string;
  orgUnitId: string;
  dn: string;
  state: string;
  source: string;
  previousDn: string | null;
}

/**
 * Brings one target's mirrored `OrgUnitContainer` rows into step with the
 * org-unit tree, and -- given what the target holds -- settles what has
 * landed. Writes rows and an audit event; never a directory.
 *
 * - An active unit with no row gets one, 'mirrored', in state 'desired'.
 * - A MANUAL row is never touched: a DN an administrator typed wins.
 * - A mirrored row whose derived DN changed gets the new DN, and keeps the DN
 *   the target last confirmed in `previousDn` -- what lets the run MOVE the OU
 *   rather than create a second one. Renamed back before any run, the pending
 *   move simply disappears.
 * - A deactivated unit's row, and a row whose unit now has a problem, are left
 *   exactly as they are: the OU stays, and so do the accounts in it. It is no
 *   longer mirrored, which the console says; nothing is deleted.
 * - A deleted unit's row is gone already (the foreign key cascades); the OU
 *   stays at the target, since there is no delete of any kind.
 *
 * A derived DN another unit's row already holds is a per-unit `dn_taken`
 * problem, never a unique-violation 500. Two mirrored rows trading DNs in one
 * rename (siblings swapping names) are applied in whichever order frees the
 * other; a genuine cycle is reported rather than forced.
 */
export async function syncMirroredContainers(
  tx: TenantClient,
  input: {
    tenantId: string;
    target: MirrorTargetFacts;
    /** Lowercased DNs the target holds, when a run has just read them. */
    existingContainers?: ReadonlySet<string>;
    actorUserId: string | null;
  },
): Promise<MirrorSyncReport> {
  const report: MirrorSyncReport = { created: [], redirected: [], settled: [], leftBehind: [], problems: [] };
  if (!targetMirrors(input.target)) return report;

  const units = await mirrorUnits(tx);
  const derivation = deriveForTarget(input.target, units);
  report.problems.push(...derivation.problems);
  const unitName = new Map(units.map((unit) => [unit.id, unit.name]));

  const rows: RowFacts[] = await tx.orgUnitContainer.findMany({
    where: { targetSystemId: input.target.id },
    select: { id: true, orgUnitId: true, dn: true, state: true, source: true, previousDn: true },
  });
  const rowByUnit = new Map(rows.map((row) => [row.orgUnitId, row]));
  const holder = new Map(rows.map((row) => [row.dn.toLowerCase(), row]));

  type Pending =
    | { kind: 'create'; orgUnitId: string; dn: string }
    | { kind: 'redirect'; row: RowFacts; dn: string };
  let pending: Pending[] = [];
  for (const [orgUnitId, dn] of derivation.dns) {
    const row = rowByUnit.get(orgUnitId);
    if (row === undefined) pending.push({ kind: 'create', orgUnitId, dn });
    else if (row.source === 'mirrored' && row.dn.toLowerCase() !== dn.toLowerCase()) {
      pending.push({ kind: 'redirect', row, dn });
    }
  }

  // Apply whatever is free, until nothing more is.
  for (;;) {
    const blocked: Pending[] = [];
    let progressed = false;
    for (const change of pending) {
      const owner = holder.get(change.dn.toLowerCase());
      const self = change.kind === 'redirect' ? change.row.id : null;
      if (owner !== undefined && owner.id !== self) {
        blocked.push(change);
        continue;
      }
      progressed = true;
      if (change.kind === 'create') {
        const created = await tx.orgUnitContainer.create({
          data: {
            tenantId: input.tenantId,
            orgUnitId: change.orgUnitId,
            targetSystemId: input.target.id,
            dn: change.dn,
            state: 'desired',
            source: 'mirrored',
          },
          select: { id: true, orgUnitId: true, dn: true, state: true, source: true, previousDn: true },
        });
        holder.set(created.dn.toLowerCase(), created);
        rowByUnit.set(created.orgUnitId, created);
        report.created.push({ orgUnitId: change.orgUnitId, dn: change.dn });
      } else {
        const { row } = change;
        // The DN the target last confirmed, kept across any number of renames
        // before a run lands one. A row the target never confirmed has no
        // previous location to move from.
        const confirmed = row.previousDn ?? (row.state === 'desired' ? null : row.dn);
        const previousDn =
          confirmed !== null && confirmed.toLowerCase() === change.dn.toLowerCase() ? null : confirmed;
        holder.delete(row.dn.toLowerCase());
        const updated = await tx.orgUnitContainer.update({
          where: { id: row.id },
          data: { dn: change.dn, previousDn },
          select: { id: true, orgUnitId: true, dn: true, state: true, source: true, previousDn: true },
        });
        holder.set(updated.dn.toLowerCase(), updated);
        rowByUnit.set(updated.orgUnitId, updated);
        report.redirected.push({ orgUnitId: row.orgUnitId, from: row.dn, to: change.dn, pendingMoveFrom: previousDn });
      }
    }
    if (!progressed || blocked.length === 0) {
      for (const change of blocked) {
        const orgUnitId = change.kind === 'create' ? change.orgUnitId : change.row.orgUnitId;
        const owner = holder.get(change.dn.toLowerCase())!;
        report.problems.push({
          orgUnitId,
          unitName: unitName.get(orgUnitId) ?? orgUnitId,
          kind: 'dn_taken',
          message: `${change.dn} is already the container of "${unitName.get(owner.orgUnitId) ?? owner.orgUnitId}" on this target${owner.source === 'manual' ? ' (materialised by hand)' : ''}, so this unit cannot be mirrored there`,
        });
      }
      break;
    }
    pending = blocked;
  }

  if (input.existingContainers !== undefined) {
    const existing = new Set([...input.existingContainers].map((dn) => dn.trim().toLowerCase()));
    for (const row of rowByUnit.values()) {
      if (row.source !== 'mirrored') continue;
      const here = existing.has(row.dn.toLowerCase());
      if (!here) continue;
      if (row.state === 'desired' || row.previousDn !== null) {
        await tx.orgUnitContainer.update({
          where: { id: row.id },
          data: { state: row.state === 'desired' ? 'adopted' : row.state, previousDn: null },
        });
        report.settled.push({ orgUnitId: row.orgUnitId, dn: row.dn });
        if (row.previousDn !== null && existing.has(row.previousDn.toLowerCase())) {
          report.leftBehind.push({ orgUnitId: row.orgUnitId, dn: row.previousDn });
        }
      }
    }
  }

  const changed =
    report.created.length + report.redirected.length + report.settled.length + report.leftBehind.length > 0;
  if (changed) {
    // Bounded: a first sync over a large tree creates a row per unit, and an
    // audit payload is not the place to list a thousand of them. The counts
    // are complete; the lists are a sample, and say so.
    const SAMPLE = 50;
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'provision.target.org_units_mirrored',
      targetType: 'TargetSystem',
      targetId: input.target.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        rootDn: derivation.rootDn,
        counts: {
          created: report.created.length,
          redirected: report.redirected.length,
          settled: report.settled.length,
          leftBehind: report.leftBehind.length,
          problems: report.problems.length,
        },
        created: report.created.slice(0, SAMPLE),
        redirected: report.redirected.slice(0, SAMPLE),
        settled: report.settled.slice(0, SAMPLE),
        leftBehind: report.leftBehind,
        problems: report.problems.slice(0, SAMPLE),
        truncated: [report.created, report.redirected, report.settled, report.problems].some(
          (list) => list.length > SAMPLE,
        ),
      },
    });
  }
  return report;
}

/**
 * The DN a person in this unit is placed at on this target by the org-unit
 * rung of the ladder, for the READ paths that answer before any run -- the
 * profile preview, the explain view, the joiner form's hint.
 *
 * The row when there is one (manual or mirrored); otherwise, for a mirroring
 * target, the DN the next run will derive. Null when neither: the ladder
 * falls through to the template, exactly as the run's does.
 */
export async function orgUnitPlacementDn(
  tx: TenantClient,
  target: MirrorTargetFacts,
  orgUnitId: string,
): Promise<string | null> {
  const row = await tx.orgUnitContainer.findFirst({
    where: { orgUnitId, targetSystemId: target.id },
    select: { dn: true },
  });
  if (row !== null && row.dn.trim() !== '') return row.dn;
  if (!targetMirrors(target)) return null;
  const derived = deriveForTarget(target, await mirrorUnits(tx));
  return derived.dns.get(orgUnitId) ?? null;
}

export interface MirrorPreviewUnit {
  id: string;
  name: string;
  parentId: string | null;
  status: string;
  /** Distance from the root; a top-level unit is 0. */
  depth: number;
  /** The DN derived from the tree, or null when it cannot be (see `problem`). */
  derivedDn: string | null;
  /** The row on this target, if any. */
  row: {
    dn: string;
    source: string;
    state: string;
    previousDn: string | null;
  } | null;
  /** Where this unit's accounts go on this target, all things considered. */
  effectiveDn: string | null;
  /**
   * 'mirrored' -- placed at the derived DN (or will be, from the next run).
   * 'manual' -- a typed DN wins over the derived one.
   * 'not_mirrored' -- a row the mirror no longer maintains: the unit is
   *   deactivated, or cannot be derived. The OU stays; nothing is deleted.
   * 'unplaced' -- no row and nothing derivable.
   */
  placement: 'mirrored' | 'manual' | 'not_mirrored' | 'unplaced';
  problem: { kind: MirrorProblemKind; message: string } | null;
  note: string | null;
}

export interface MirrorPreview {
  mirrorOrgUnits: boolean;
  placesAccountsInContainers: boolean;
  baseDn: string;
  rootDn: string | null;
  rootProblem: string | null;
  units: MirrorPreviewUnit[];
}

/**
 * The tree as a mirroring target would place it: every unit, its derived DN,
 * its row and what wins. Read-only and local -- it reads the tenant's real org
 * units and this target's rows and asks the directory nothing, so it is safe
 * to show before mirroring is on, and with a root that has not been saved yet
 * (`rootOverride`), which is how the target page previews a change.
 */
export async function mirrorPreview(
  tenantId: string,
  targetSystemId: string,
  options: { rootOverride?: string | null } = {},
): Promise<MirrorPreview | null> {
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findUnique({
      where: { id: targetSystemId },
      select: { id: true, type: true, config: true, mirrorOrgUnits: true, orgUnitRootDn: true },
    });
    if (target === null) return null;
    const effective: MirrorTargetFacts = {
      ...target,
      orgUnitRootDn: options.rootOverride === undefined ? target.orgUnitRootDn : options.rootOverride,
    };
    const placesAccounts = targetPlacesAccountsInContainers(target.type, target.config);
    const units = await mirrorUnits(tx);
    const derivation = deriveForTarget(effective, units);
    const rows = await tx.orgUnitContainer.findMany({
      where: { targetSystemId },
      select: { orgUnitId: true, dn: true, source: true, state: true, previousDn: true },
    });
    const rowByUnit = new Map(rows.map((row) => [row.orgUnitId, row]));
    const problemByUnit = new Map(derivation.problems.map((p) => [p.orgUnitId, p]));
    // Collisions with ANOTHER unit's row are only knowable against the rows,
    // so they are computed here as the sync computes them.
    const holder = new Map(rows.map((row) => [row.dn.toLowerCase(), row.orgUnitId]));

    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const depthOf = (id: string): number => {
      let depth = 0;
      const seen = new Set<string>();
      let parentId = byId.get(id)?.parentId ?? null;
      while (parentId !== null && byId.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId);
        depth += 1;
        parentId = byId.get(parentId)!.parentId;
      }
      return depth;
    };

    const result: MirrorPreviewUnit[] = units.map((unit) => {
      const row = rowByUnit.get(unit.id) ?? null;
      const derivedDn = derivation.dns.get(unit.id) ?? null;
      let problem = problemByUnit.get(unit.id) ?? null;
      if (problem === null && derivedDn !== null) {
        const owner = holder.get(derivedDn.toLowerCase());
        if (owner !== undefined && owner !== unit.id) {
          problem = {
            orgUnitId: unit.id,
            unitName: unit.name,
            kind: 'dn_taken',
            message: `${derivedDn} is already the container of "${byId.get(owner)?.name ?? owner}" on this target`,
          };
        }
      }
      const usableDerived = problem === null ? derivedDn : null;
      let placement: MirrorPreviewUnit['placement'];
      let note: string | null = null;
      let effectiveDn: string | null;
      if (row !== null && row.source === 'manual') {
        placement = 'manual';
        effectiveDn = row.dn;
        note =
          usableDerived !== null && usableDerived.toLowerCase() !== row.dn.toLowerCase()
            ? `materialised by hand; mirroring would place it at ${usableDerived}`
            : null;
      } else if (unit.status !== 'active') {
        placement = row === null ? 'unplaced' : 'not_mirrored';
        effectiveDn = row?.dn ?? null;
        note = row === null ? 'deactivated, so not mirrored' : 'deactivated: no longer mirrored, and its OU stays where it is';
      } else if (usableDerived !== null && effective.mirrorOrgUnits && placesAccounts) {
        placement = 'mirrored';
        effectiveDn = usableDerived;
        if (row === null) note = 'the next run creates this OU';
        else if (row.dn.toLowerCase() !== usableDerived.toLowerCase()) {
          note = `the next run moves ${row.previousDn ?? row.dn} here`;
        } else if (row.previousDn !== null) note = `the next run moves ${row.previousDn} here`;
        else if (row.state === 'desired') note = 'the next run creates this OU';
      } else if (usableDerived !== null) {
        // Mirroring is off: this is what it WOULD do.
        placement = row === null ? 'unplaced' : 'not_mirrored';
        effectiveDn = row?.dn ?? null;
        note = row === null ? null : 'mirroring is off: this row is kept as it is';
      } else {
        placement = row === null ? 'unplaced' : 'not_mirrored';
        effectiveDn = row?.dn ?? null;
        note = row === null ? null : 'cannot be mirrored: no longer kept in step, and its OU stays where it is';
      }
      return {
        id: unit.id,
        name: unit.name,
        parentId: unit.parentId,
        status: unit.status,
        depth: depthOf(unit.id),
        derivedDn,
        row: row === null ? null : { dn: row.dn, source: row.source, state: row.state, previousDn: row.previousDn },
        effectiveDn,
        placement,
        problem: problem === null ? null : { kind: problem.kind, message: problem.message },
        note,
      };
    });

    return {
      mirrorOrgUnits: target.mirrorOrgUnits,
      placesAccountsInContainers: placesAccounts,
      baseDn: baseDnOf(target.config),
      rootDn: derivation.rootDn,
      rootProblem: derivation.rootProblem,
      units: result,
    };
  });
}

export type SwitchToMirroredOutcome =
  | { ok: true; dn: string; pendingMoveFrom: string | null }
  | {
      ok: false;
      reason: 'no_such_row' | 'not_manual' | 'not_mirroring' | 'cannot_derive' | 'dn_taken';
      message: string;
    };

/**
 * "Switch to mirrored": hands a manually materialised unit over to the mirror.
 *
 * Rewrites the row to the derived DN with `source = 'mirrored'` and, when the
 * target had confirmed the typed DN, keeps that in `previousDn` -- so the next
 * run MOVES the existing OU and the accounts in it to their place in the tree
 * (the flat `OU=IT,OU=Syntra` becoming `OU=IT,OU=contoso.local,OU=Syntra`),
 * under the guard, confirmed by a person. Nothing is written to the directory
 * here.
 */
export async function switchToMirrored(
  tenantId: string,
  input: { orgUnitId: string; targetSystemId: string; actorUserId: string | null; sourceIp: string | null },
): Promise<SwitchToMirroredOutcome> {
  return withTenant(tenantId, (tx) => switchToMirroredIn(tx, input));
}

/**
 * {@link switchToMirrored} inside a transaction the caller already holds, so
 * the bulk switch ({@link switchAllToMirrored}) converts many rows through
 * exactly this code -- the same refusals, the same `previousDn` rule, the
 * same audit event per unit -- rather than a second copy of it that drifts.
 */
export async function switchToMirroredIn(
  tx: TenantClient,
  input: { orgUnitId: string; targetSystemId: string; actorUserId: string | null; sourceIp: string | null },
  /**
   * The target's derivation, when the caller has already made it. The bulk
   * switch converts many rows of one target in one transaction, and the tree
   * does not change between them -- only the rows do, and those are re-read
   * here every time -- so deriving it once per row would be the same answer
   * computed n times over.
   */
  prepared?: { target: MirrorTargetFacts; derivation: MirrorDerivation },
): Promise<SwitchToMirroredOutcome> {
  const row = await tx.orgUnitContainer.findFirst({
    where: { orgUnitId: input.orgUnitId, targetSystemId: input.targetSystemId },
  });
  if (row === null) return { ok: false, reason: 'no_such_row', message: 'this unit is not materialised on this target' };
  if (row.source !== 'manual') return { ok: false, reason: 'not_manual', message: 'this container is already mirrored' };
  const target =
    prepared?.target ??
    (await tx.targetSystem.findUnique({
      where: { id: input.targetSystemId },
      select: { id: true, type: true, config: true, mirrorOrgUnits: true, orgUnitRootDn: true },
    }));
  if (target === null || !targetMirrors(target)) {
    return {
      ok: false,
      reason: 'not_mirroring',
      message: 'this target does not mirror org units; turn "Mirror org units as OUs" on first',
    };
  }
  const derivation = prepared?.derivation ?? deriveForTarget(target, await mirrorUnits(tx));
  const derived = derivation.dns.get(input.orgUnitId);
  if (derived === undefined) {
    const problem = derivation.problems.find((p) => p.orgUnitId === input.orgUnitId);
    return {
      ok: false,
      reason: 'cannot_derive',
      message: problem?.message ?? 'this unit cannot be mirrored (it is not active)',
    };
  }
  const same = derived.toLowerCase() === row.dn.toLowerCase();
  if (!same) {
    const owner = await tx.orgUnitContainer.findFirst({
      where: { targetSystemId: input.targetSystemId, dn: { equals: derived, mode: 'insensitive' } },
      select: { orgUnitId: true },
    });
    if (owner !== null && owner.orgUnitId !== input.orgUnitId) {
      return { ok: false, reason: 'dn_taken', message: `${derived} is already the container of another unit on this target` };
    }
  }
  const pendingMoveFrom = same || row.state === 'desired' ? null : row.dn;
  await tx.orgUnitContainer.update({
    where: { id: row.id },
    data: { source: 'mirrored', dn: derived, previousDn: pendingMoveFrom },
  });
  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'orgUnit.container.switch_to_mirrored',
    targetType: 'OrgUnit',
    targetId: input.orgUnitId,
    outcome: 'success',
    sourceIp: input.sourceIp,
    payload: { targetSystemId: input.targetSystemId, from: row.dn, to: derived, pendingMoveFrom },
  });
  return { ok: true, dn: derived, pendingMoveFrom };
}

export interface SwitchedToMirrored {
  orgUnitId: string;
  unitName: string;
  /** The typed DN the row held. */
  from: string;
  /** The derived DN it holds now. */
  dn: string;
  /** Where the next run moves the OU from; null when there is nothing to move. */
  pendingMoveFrom: string | null;
}

export interface NotSwitchedToMirrored {
  orgUnitId: string;
  unitName: string;
  /** The typed DN, still in force. */
  dn: string;
  reason: Extract<SwitchToMirroredOutcome, { ok: false }>['reason'];
  message: string;
}

export type SwitchAllToMirroredOutcome =
  | {
      ok: true;
      /** Every row converted, parents first, in the order it was converted. */
      switched: SwitchedToMirrored[];
      /**
       * Every manual row on an active unit that was NOT converted, and why --
       * a name too long to mirror, a derived DN another unit's row holds. Left
       * exactly as it was, typed DN and all; never dropped from the answer.
       */
      skipped: NotSwitchedToMirrored[];
    }
  | { ok: false; reason: 'no_such_target' | 'not_mirroring'; message: string };

/**
 * "Switch all to mirrored": hands EVERY hand-typed placement on one mirroring
 * target to the mirror at once.
 *
 * Why this exists: a tenant that materialised its units by hand and then
 * turned mirroring on sees nothing move -- a typed DN always wins, by design
 * -- and converting forty units one button at a time is how some of them get
 * missed. This is that button pressed for each of them, and nothing more:
 * every conversion goes through {@link switchToMirroredIn}, with its refusals
 * and its own `orgUnit.container.switch_to_mirrored` audit event, so the
 * audit trail of a bulk switch reads exactly like n single ones.
 *
 * **One transaction.** Either every convertible row is converted or, on an
 * error, none is -- a half-switched target, some units mirrored and some not
 * for no reason anybody chose, is worse than either end state. A row that
 * CANNOT be converted (its unit cannot be derived, or another unit's row holds
 * its derived DN) is not an error: it is left as it is and reported by name
 * in `skipped`, exactly as the single switch would have refused it.
 *
 * **Parents first**, by depth in the tree. The planner moves a renamed parent
 * once and lets its children ride along; converting in tree order keeps the
 * audit trail in the order an administrator reads it, and means a child's
 * `dn_taken` check sees its parent's row already where it is going. A row
 * blocked only by a sibling not yet converted (two units trading DNs) is
 * retried until a pass makes no progress, as the run's sync does.
 *
 * Only ACTIVE units' manual rows are considered: a deactivated unit is not
 * mirrored at all, so its typed row is the only thing still describing where
 * its OU is, and converting it would have nowhere to point.
 *
 * Nothing is written to the directory. Every OU this changes the address of
 * is MOVED by the next run, and any container move holds that run for a
 * person to confirm.
 */
export async function switchAllToMirrored(
  tenantId: string,
  input: { targetSystemId: string; actorUserId: string | null; sourceIp: string | null },
): Promise<SwitchAllToMirroredOutcome> {
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findUnique({
      where: { id: input.targetSystemId },
      select: { id: true, type: true, config: true, mirrorOrgUnits: true, orgUnitRootDn: true },
    });
    if (target === null) return { ok: false, reason: 'no_such_target', message: 'no such target' };
    if (!targetMirrors(target)) {
      return {
        ok: false,
        reason: 'not_mirroring',
        message: 'this target does not mirror org units; turn "Mirror org units as OUs" on first',
      };
    }
    const units = await mirrorUnits(tx);
    const derivation = deriveForTarget(target, units);
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const depthOf = (id: string): number => {
      let depth = 0;
      const seen = new Set<string>();
      let parentId = byId.get(id)?.parentId ?? null;
      while (parentId !== null && byId.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId);
        depth += 1;
        parentId = byId.get(parentId)!.parentId;
      }
      return depth;
    };

    const manual = await tx.orgUnitContainer.findMany({
      where: { targetSystemId: target.id, source: 'manual', orgUnit: { status: 'active' } },
      select: { orgUnitId: true, dn: true },
    });
    // Depth, then name, then id: a stable order, so two presses over the
    // same tree audit in the same order.
    let queue = manual
      .map((row) => ({ ...row, unitName: byId.get(row.orgUnitId)?.name ?? row.orgUnitId, depth: depthOf(row.orgUnitId) }))
      .sort((a, b) => a.depth - b.depth || a.unitName.localeCompare(b.unitName) || a.orgUnitId.localeCompare(b.orgUnitId));

    const switched: SwitchedToMirrored[] = [];
    // Keyed by unit, so a row refused on one pass and converted on the next
    // is reported once, as converted.
    const skipped = new Map<string, NotSwitchedToMirrored>();
    for (;;) {
      const blocked: typeof queue = [];
      let progressed = false;
      for (const row of queue) {
        // A refusal returns before the helper writes anything, so a skipped
        // row leaves no half-written state behind in this transaction.
        const outcome = await switchToMirroredIn(
          tx,
          { orgUnitId: row.orgUnitId, targetSystemId: target.id, actorUserId: input.actorUserId, sourceIp: input.sourceIp },
          { target, derivation },
        );
        if (outcome.ok) {
          progressed = true;
          skipped.delete(row.orgUnitId);
          switched.push({ orgUnitId: row.orgUnitId, unitName: row.unitName, from: row.dn, dn: outcome.dn, pendingMoveFrom: outcome.pendingMoveFrom });
        } else {
          skipped.set(row.orgUnitId, { orgUnitId: row.orgUnitId, unitName: row.unitName, dn: row.dn, reason: outcome.reason, message: outcome.message });
          // Only a DN held by another row can come free on a later pass.
          if (outcome.reason === 'dn_taken') blocked.push(row);
        }
      }
      if (!progressed || blocked.length === 0) break;
      queue = blocked;
    }
    return { ok: true, switched, skipped: [...skipped.values()] };
  });
}
