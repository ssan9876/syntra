import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { Permission } from './permissions.js';

export async function createRole(
  tx: TenantClient,
  name: string,
  permissions: Permission[],
  opts: { builtIn?: boolean; description?: string } = {},
) {
  const tenantId = await currentTenant(tx);
  return tx.role.create({
    data: {
      tenantId,
      name,
      permissions,
      builtIn: opts.builtIn ?? false,
      description: opts.description ?? null,
    },
  });
}

export async function listRoles(tx: TenantClient) {
  return tx.role.findMany({ orderBy: { name: 'asc' } });
}

/**
 * Grants a role, optionally confined to one organizational unit. Idempotent:
 * the same role and scope assigned twice is one assignment.
 *
 * Not an upsert. Prisma cannot address a compound unique key holding a null,
 * and for good reason — SQL treats NULL as distinct from NULL, so the compound
 * constraint does not cover unscoped grants at all. A partial unique index
 * enforces that case in the database; this lookup keeps the call idempotent.
 */
export async function assignRole(
  tx: TenantClient,
  userId: string,
  roleId: string,
  scopeOrgUnitId?: string,
): Promise<void> {
  const tenantId = await currentTenant(tx);
  const scope = scopeOrgUnitId ?? null;

  const existing = await tx.roleAssignment.findFirst({
    where: { roleId, userId, scopeOrgUnitId: scope },
  });
  if (existing) return;

  await tx.roleAssignment.create({
    data: { tenantId, roleId, userId, scopeOrgUnitId: scope },
  });
}

export async function revokeRole(
  tx: TenantClient,
  userId: string,
  roleId: string,
  scopeOrgUnitId?: string,
): Promise<void> {
  await tx.roleAssignment.deleteMany({
    where: {
      userId,
      roleId,
      ...(scopeOrgUnitId === undefined
        ? {}
        : { scopeOrgUnitId: scopeOrgUnitId ?? null }),
    },
  });
}

/** Every permission the user holds anywhere, regardless of scope. */
export async function permissionsForUser(
  tx: TenantClient,
  userId: string,
): Promise<Set<Permission>> {
  const assignments = await tx.roleAssignment.findMany({
    where: { userId },
    include: { role: true },
  });

  const set = new Set<Permission>();
  for (const a of assignments) {
    for (const p of a.role.permissions) set.add(p as Permission);
  }
  return set;
}

/**
 * Whether the user may exercise `permission`, optionally within one
 * organizational unit.
 *
 * An unscoped assignment applies everywhere. A scoped assignment applies only
 * to its own unit — and notably does NOT satisfy a question asked with no
 * scope, because that question is tenant-wide and a scoped grant is not.
 *
 * A scoped assignment on a DEACTIVATED unit grants nothing, by the same rule
 * that stops a deactivated unit handing out applications. Administrative
 * authority over a department that has been closed is authority over nothing,
 * and leaving it standing would make deactivation a control that retires a
 * unit's grants while quietly keeping its administrators.
 *
 * The assignment row is untouched: reactivating the unit restores it, and the
 * record of who administered what survives either way.
 */
export async function hasPermission(
  tx: TenantClient,
  userId: string,
  permission: Permission,
  scopeOrgUnitId?: string,
): Promise<boolean> {
  const assignments = await tx.roleAssignment.findMany({
    where: { userId },
    include: { role: true },
  });

  // ONE extra query at most, and only when it can change the answer.
  //
  // Only the unit actually being asked about can be the deciding one — a
  // scoped assignment on any other unit already fails the match below — so
  // this asks about that unit alone, and only when the caller named a scope
  // AND the user actually holds an assignment on it. A tenant-wide question,
  // or a scoped one from somebody whose roles are all tenant-wide, adds
  // nothing at all, which is the shape of nearly every call.
  //
  // `RoleAssignment.scopeOrgUnitId` carries no Prisma relation, so the status
  // cannot be joined in the query above.
  const scopeCouldDecide =
    scopeOrgUnitId !== undefined &&
    assignments.some((a) => a.scopeOrgUnitId === scopeOrgUnitId);
  let scopeIsActive = true;
  if (scopeCouldDecide) {
    const unit = await tx.orgUnit.findUnique({
      where: { id: scopeOrgUnitId },
      select: { status: true },
    });
    scopeIsActive = unit?.status === 'active';
  }

  return assignments.some((a) => {
    if (!a.role.permissions.includes(permission)) return false;
    if (a.scopeOrgUnitId === null) return true;
    if (!scopeIsActive) return false;
    return scopeOrgUnitId !== undefined && a.scopeOrgUnitId === scopeOrgUnitId;
  });
}

/**
 * Whether the user holds any role at all. Used to decide whether a session may
 * be elevated to an administrative one — not to decide what it may then do.
 */
export async function isAdministrator(
  tx: TenantClient,
  userId: string,
): Promise<boolean> {
  const count = await tx.roleAssignment.count({ where: { userId } });
  return count > 0;
}
