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

export const createGroupRequest = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
});

export const createOrgUnitRequest = z.object({
  name: z.string().min(1).max(256),
  parentId: z.string().uuid().optional(),
});

export const idParam = z.object({ id: z.string().uuid() });

export const membershipParams = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});
