import { z } from 'zod';

export const createUserRequest = z.object({
  login: z.string().min(1).max(256),
  email: z.string().email(),
  displayName: z.string().min(1).max(256),
  orgUnitId: z.string().uuid().optional(),
});
export type CreateUserRequest = z.infer<typeof createUserRequest>;

export const deactivateUserRequest = z.object({
  reason: z.string().min(1).max(512),
});

/**
 * The same shape, and REQUIRED for the same reason.
 *
 * A deactivation without a reason is a row that says access was taken away and
 * refuses to say why — which is exactly the question asked six months later,
 * when nobody remembers. `min(1)` is what stops an empty box passing for an
 * answer.
 */
export const deactivateGroupRequest = z.object({
  reason: z.string().min(1).max(512),
});

export const deactivatePersonRequest = z.object({
  reason: z.string().min(1).max(512),
});

export const deactivateOrgUnitRequest = z.object({
  reason: z.string().min(1).max(512),
});

export const createGroupRequest = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
});

export const createOrgUnitRequest = z.object({
  name: z.string().min(1).max(256),
  parentId: z.string().uuid().optional(),
});

/**
 * EDITING what already exists, as opposed to creating it.
 *
 * Every field is optional and at least one must be present: a PATCH naming no
 * field is almost certainly a bug in the caller, and answering it with 200 and
 * an unchanged row hides that. `strict()` refuses an unknown key for the same
 * reason — a client sending `displayname` should be told, not silently ignored.
 *
 * `login` is deliberately NOT here. It is what somebody types to sign in and
 * what audit rows are read by; changing it is an account migration, not an
 * edit, and it needs a decision about the trail that this form is not the
 * place to make.
 */
export const patchGroupRequest = z
  .object({
    name: z.string().min(1).max(256).optional(),
    // Nullable, not merely optional: clearing a description is a thing to do,
    // and `undefined` cannot say it because it already means "leave alone".
    description: z.string().max(1024).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const patchOrgUnitRequest = z
  .object({
    name: z.string().min(1).max(256).optional(),
    /** Null moves the unit to the top level. */
    parentId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const patchUserDetailsRequest = z
  .object({
    displayName: z.string().min(1).max(256).optional(),
    email: z.string().email().optional(),
    /** Null takes the user out of the hierarchy entirely. */
    orgUnitId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

/**
 * An administrator setting a password on somebody's behalf.
 *
 * The ceiling matches `validateNewPassword`'s: Argon2id's cost is proportional
 * to its input, and an unbounded password field is a way to spend a server's
 * memory on demand. The floor is 1 rather than the tenant's minimum, because
 * the length policy belongs in one place — checking it here as well would
 * state the rule twice and the two would eventually disagree.
 */
export const setUserPasswordRequest = z
  .object({ password: z.string().min(1).max(1024) })
  .strict();

export const idParam = z.object({ id: z.string().uuid() });

export const membershipParams = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});
