import { z } from 'zod';

export const loginRequest = z.object({
  login: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const elevateRequest = z.object({
  password: z.string().min(1).max(1024),
});
export type ElevateRequest = z.infer<typeof elevateRequest>;

/**
 * The 1024 ceiling matches `loginRequest` and the policy's own, and is there
 * for the same reason: Argon2id's cost scales with input, so an unbounded
 * password field is a way to spend the server's memory on request.
 *
 * No minimum length on `newPassword` beyond 1. The tenant's `passwordMinLength`
 * is the real floor and the policy check reports it with a message; enforcing
 * a different number here would refuse at the schema with nothing to say.
 */
export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequest>;

/**
 * Choosing a new password after the old one expired mid-sign-in.
 *
 * No `currentPassword`, and that is deliberate: the attempt token exists only
 * because `authorize()` already accepted the old password and satisfied
 * whatever factor the policy asked for. Asking for it again would be friction
 * bought with nothing.
 */
export const renewPasswordRequest = z.object({
  attemptToken: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(1024),
});
export type RenewPasswordRequest = z.infer<typeof renewPasswordRequest>;

export const sessionResponse = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  scope: z.enum(['portal', 'admin']),
  mayElevate: z.boolean(),
  permissions: z.array(z.string()),
});
export type SessionResponse = z.infer<typeof sessionResponse>;
