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

/**
 * Issuing a machine token.
 *
 * `scopes` is validated against the real permission list rather than accepted
 * as free text: an unknown scope would be a token that silently grants
 * nothing, discovered as a 403 nobody can explain. A typo is a 400 here
 * instead.
 */
export const issueApiTokenRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** Empty means the account's own authority. */
    scopes: z.array(z.string().min(1).max(64)).max(64).default([]),
    /**
     * Null is allowed and means it never expires. The API does not invent a
     * default: a lifetime is a policy the operator states, and the console is
     * where the ninety-day suggestion lives.
     */
    expiresAt: z.string().datetime().nullable().default(null),
  })
  .strict();

export const apiTokenView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiTokenViewDto = z.infer<typeof apiTokenView>;
