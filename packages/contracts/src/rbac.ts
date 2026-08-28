import { z } from 'zod';

/**
 * A role, as an administrator types it.
 *
 * `permissions` is `z.array(z.string())` and NOT an enum built from the
 * catalogue, deliberately. The catalogue is a closed set defined in
 * `@syntra/core`'s `permissions.ts` and enforced there by
 * `assertPermissionNames`; declaring it a second time here would be a second
 * copy to keep in step with the one `hasPermission` actually compares against,
 * and the two would drift the first time somebody added a permission and
 * forgot this file. The refusal is a 422 naming the offending value, which is
 * what the console renders against the field.
 *
 * `.strict()` for the reason `provision.ts` writes out at length: this body
 * REPLACES the permission set, so a typoed key stripped silently would be a
 * save that reports success and changed something other than what was meant.
 *
 * `.min(1)` on the list: a role with no permissions grants nothing and is
 * indistinguishable from a mistake. Deleting the role is how you say that.
 */
export const roleBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullable().default(null),
    permissions: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type RoleBody = z.input<typeof roleBody>;

/**
 * Editing one. Every field optional and at least one present — a PATCH naming
 * no field is a bug in the caller, and answering it 204 hides that.
 */
export const patchRoleBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
    permissions: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

/**
 * Granting the role, optionally confined to one organizational unit.
 *
 * Nullable rather than absent for the unscoped case, because the two readings
 * of a missing field — "tenant-wide" and "I forgot" — are the difference
 * between authority over one department and authority over everything.
 */
export const roleAssignmentBody = z
  .object({
    userId: z.string().uuid(),
    scopeOrgUnitId: z.string().uuid().nullable().default(null),
  })
  .strict();

export const roleAssignmentParams = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

/**
 * Which grant to withdraw, when somebody holds the role more than once.
 *
 * ABSENT means every scope, which is what the path alone has always meant and
 * remains the right default: taking "the role" off somebody means all of it.
 * Naming a unit withdraws that one grant and leaves the others -- including
 * the tenant-wide one -- standing.
 *
 * A query parameter rather than a body. DELETE bodies are permitted and widely
 * mishandled, and this names WHICH of a set the path already identifies, which
 * is what a query string is for.
 */
export const roleAssignmentQuery = z.object({
  scopeOrgUnitId: z.string().uuid().optional(),
});
