import type { TenantClient } from '@syntra/db';
import { PERMISSIONS } from '../rbac/permissions.js';
import { MAX_ORG_UNIT_DEPTH } from './collect.js';

/**
 * `govern.read` is scopeable to an organizational unit, because reading Govern
 * tenant-wide is reading everybody's access and a team lead who reviews their
 * own department should not be handed that.
 *
 * Core's `hasPermission(tx, userId, permission, scopeOrgUnitId?)` cannot answer
 * this question. It matches a scoped assignment only against that EXACT unit id
 * and explicitly refuses to satisfy an unscoped question, and `requirePermission`
 * asks unscoped — so a scope-only holder gets 403 on every Govern route, and a
 * scope on Head Office would not admit a person in a unit beneath it. Neither
 * behaviour is wrong for Core's callers; both are wrong for this one.
 *
 * `scope.test.ts` records both behaviours as tests, so a future reader does not
 * assume the standard guard would have worked.
 */
export type GovernScope =
  | { kind: 'tenant' }
  | { kind: 'orgUnits'; orgUnitIds: string[] }
  | { kind: 'none' };

/** The named units plus every unit beneath them, with a depth cap and a seen-set. */
export async function orgUnitDescendants(
  tx: TenantClient,
  roots: readonly string[],
): Promise<string[]> {
  if (roots.length === 0) return [];

  const units = await tx.orgUnit.findMany({ select: { id: true, parentId: true } });
  const childrenByParent = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.parentId === null) continue;
    childrenByParent.set(unit.parentId, [...(childrenByParent.get(unit.parentId) ?? []), unit.id]);
  }

  const seen = new Set<string>();
  const queue: { id: string; depth: number }[] = roots.map((id) => ({ id, depth: 0 }));
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.id) || next.depth >= MAX_ORG_UNIT_DEPTH) continue;
    seen.add(next.id);
    for (const child of childrenByParent.get(next.id) ?? []) {
      queue.push({ id: child, depth: next.depth + 1 });
    }
  }
  return [...seen];
}

export async function governReadScope(tx: TenantClient, userId: string): Promise<GovernScope> {
  const assignments = await tx.roleAssignment.findMany({
    where: { userId },
    include: { role: { select: { permissions: true } } },
  });
  const relevant = assignments.filter((a) => a.role.permissions.includes(PERMISSIONS.GOVERN_READ));
  if (relevant.length === 0) return { kind: 'none' };
  if (relevant.some((a) => a.scopeOrgUnitId === null)) return { kind: 'tenant' };

  const roots = relevant.map((a) => a.scopeOrgUnitId).filter((x): x is string => x !== null);
  return { kind: 'orgUnits', orgUnitIds: await orgUnitDescendants(tx, roots) };
}

/**
 * A person whose user sits in NO unit is not "in every unit". Admitting them
 * under an org-unit scope would silently widen every scoped read to the
 * unplaced population, which on a fresh import is everybody.
 */
export function scopeAdmitsPerson(scope: GovernScope, personOrgUnitId: string | null): boolean {
  if (scope.kind === 'tenant') return true;
  if (scope.kind === 'none') return false;
  return personOrgUnitId !== null && scope.orgUnitIds.includes(personOrgUnitId);
}

/**
 * `'all'` rather than a set of every person, so a tenant-scoped caller costs no
 * query and no allocation on a report over 40,000 people.
 */
export async function personIdsInScope(
  tx: TenantClient,
  scope: GovernScope,
): Promise<Set<string> | 'all'> {
  if (scope.kind === 'tenant') return 'all';
  if (scope.kind === 'none') return new Set();

  const users = await tx.user.findMany({
    where: { orgUnitId: { in: scope.orgUnitIds }, personId: { not: null } },
    select: { personId: true },
  });
  return new Set(users.map((u) => u.personId).filter((id): id is string => id !== null));
}

/**
 * Does this user hold `permission` through ANY assignment, scoped or not?
 *
 * The companion to `governReadScope`, and it exists for the same reason.
 * `hasPermission(tx, userId, p)` asks unscoped and Core deliberately refuses a
 * scoped assignment asked that way — so a department lead whose single role
 * carries `govern.read` AND `govern.export`, assigned with a scope, is refused
 * the export. That is this task's own defect one permission along: the lead can
 * read their department on the screen and cannot export the same rows.
 *
 * The scope does not gate WHETHER you may export; it gates WHAT comes out, and
 * the row filter on the export route is what enforces that. So the question
 * here is membership, not scope.
 *
 * Deliberately narrow: this is for the Govern routes that pair a second
 * permission with the scoped read. Anything asking a genuinely scoped question
 * still goes through Core's `hasPermission`.
 */
export async function holdsGovernPermission(
  tx: TenantClient,
  userId: string,
  permission: string,
): Promise<boolean> {
  const assignments = await tx.roleAssignment.findMany({
    where: { userId },
    include: { role: { select: { permissions: true } } },
  });
  return assignments.some((a) => a.role.permissions.includes(permission));
}
