import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { isPermission, type Permission } from './permissions.js';

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


/**
 * A role change the domain will not make, with a code the API turns into a
 * problem type.
 *
 * The same shape `CampaignRefusedError` and `DecisionRefusedError` use: these
 * are decisions this module made about a well-formed request, not faults, and a
 * 500 would tell the caller nothing they can act on.
 */
export class RoleRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RoleRefusedError';
  }
}

/**
 * The permission names, checked against the closed catalogue.
 *
 * THE CATALOGUE LIVES HERE, and this is the one place it is enforced on the
 * way in. The obvious alternative -- a `z.enum` in the contract built from
 * `ALL_PERMISSIONS` -- would put a second copy of the list at the edge, and a
 * second copy is a second thing to keep in step with `hasPermission`, which
 * compares against this one. It is also what `isPermission` was written for:
 * the function existed, was tested, and had no caller anywhere in the tree.
 *
 * The offending value is named in the message because the caller is an
 * administrator looking at a list of checkboxes and a typo in a permission
 * string is otherwise indistinguishable from a permission that does not exist
 * yet.
 */
export function assertPermissionNames(values: readonly string[]): Permission[] {
  const unknown = values.filter((value) => !isPermission(value));
  if (unknown.length > 0) {
    throw new RoleRefusedError(
      'unknown-permission',
      `not permissions this product has: ${unknown.join(', ')}`,
    );
  }
  return values as Permission[];
}

export async function readRole(tx: TenantClient, roleId: string) {
  return tx.role.findUniqueOrThrow({
    where: { id: roleId },
    include: { assignments: true },
  });
}

/**
 * Every role with how many people hold it.
 *
 * The count is what makes the screen readable: "Owner -- 1 holder" and
 * "Auditor -- 0 holders" are different facts about whether a permission change
 * matters, and a list of names without them is a list somebody has to click
 * through one row at a time.
 */
export async function listRolesWithAssignmentCounts(tx: TenantClient) {
  const roles = await tx.role.findMany({
    orderBy: { name: 'asc' },
    include: { assignments: { select: { userId: true } } },
  });
  return roles.map(({ assignments, ...role }) => ({
    ...role,
    assignmentCount: new Set(assignments.map((a) => a.userId)).size,
  }));
}

/**
 * Changes a role's name, description or permission set.
 *
 * The permission set is REPLACED WHOLE rather than merged, and the caller
 * sends the whole thing. A merge would need an add/remove vocabulary the
 * screen does not have, and "the permissions are what the boxes say" is the
 * only rule an administrator can predict from looking at the form.
 *
 * A built-in role is editable HERE, deliberately, and that is the point of the
 * whole task: `Role.permissions` is a snapshot the seed wrote once, the
 * catalogue grew in six later commits, and the Owner of an upgraded
 * installation got 403 on every new module with no way to grant itself the
 * permission but raw SQL. Deletion is a different question -- see below.
 */
export async function updateRole(
  tx: TenantClient,
  roleId: string,
  input: {
    // `| undefined` explicitly, because the tree runs with
    // `exactOptionalPropertyTypes` and a zod-parsed PATCH body types its
    // absent fields that way. The body below already branches on
    // `=== undefined`, so widening the type describes what the function does
    // rather than forcing every caller to strip its own optionals.
    name?: string | undefined;
    description?: string | null | undefined;
    permissions?: readonly string[] | undefined;
  },
): Promise<void> {
  const role = await tx.role.findUniqueOrThrow({ where: { id: roleId } });

  await tx.role.update({
    where: { id: role.id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.permissions === undefined
        ? {}
        : { permissions: assertPermissionNames(input.permissions) }),
    },
  });
}

/**
 * Deletes a role nobody holds.
 *
 * Two refusals, both of them about damage that is not visible from the button.
 * `RoleAssignment` cascades from `Role`, so deleting a held role silently
 * revokes administrative authority from however many people held it, with no
 * record of what they had; and a built-in role is the one the seed wrote and
 * the one the permission backfill migration targets, so deleting it makes the
 * installation unrepairable by the mechanism that repairs it.
 *
 * The holder count is in the message because "it is in use" without a number
 * is not something the reader can act on.
 */
export async function deleteRole(tx: TenantClient, roleId: string): Promise<void> {
  const role = await tx.role.findUniqueOrThrow({
    where: { id: roleId },
    include: { assignments: { select: { userId: true } } },
  });

  if (role.builtIn) {
    throw new RoleRefusedError(
      'built-in-role',
      `"${role.name}" is a built-in role: it is what the seed created and what the permission backfill targets, so it cannot be deleted. Change its permissions instead.`,
    );
  }
  const holders = new Set(role.assignments.map((a) => a.userId)).size;
  if (holders > 0) {
    throw new RoleRefusedError(
      'role-in-use',
      `${holders} ${holders === 1 ? 'person holds' : 'people hold'} "${role.name}". Deleting it would revoke that authority with no record of what it was; take the role off them first.`,
    );
  }

  await tx.role.delete({ where: { id: role.id } });
}

/**
 * How many people hold this permission TENANT-WIDE.
 *
 * The denominator behind the lockout guard the role API applies: a change that
 * leaves nobody able to administer roles leaves an installation that can only
 * be repaired with SQL, which is exactly the state this whole task exists to
 * get out of.
 *
 * Unscoped assignments only, and that is not an oversight. `hasPermission`
 * deliberately refuses a scoped grant asked with no scope -- a tenant-wide
 * question is not answered by authority over one department -- so a
 * department-scoped `rbac.manage` cannot reach the role API at all and must
 * not count towards "somebody can still do this".
 */
export async function countHoldersOf(
  tx: TenantClient,
  permission: Permission,
): Promise<number> {
  const assignments = await tx.roleAssignment.findMany({
    where: { scopeOrgUnitId: null },
    include: { role: true },
  });
  return new Set(
    assignments
      .filter((a) => a.role.permissions.includes(permission))
      .map((a) => a.userId),
  ).size;
}
