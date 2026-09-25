import { z } from 'zod';

/**
 * The one-time link to a created account's initial password.
 *
 * The token is 32 random bytes, base64url: 43 characters. Bounded on the way
 * in so a path parameter a caller chooses the length of is refused before it
 * is hashed, and restricted to the base64url alphabet so nothing that could
 * be a path fragment or an injection reaches the lookup.
 */
export const credentialPickupTokenParam = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) })
  .strict();

export const credentialPickupStateSchema = z.enum(['ready', 'used', 'expired', 'revoked']);
export type CredentialPickupState = z.infer<typeof credentialPickupStateSchema>;

/** `GET /api/credential-pickup/:token`. Never the password. */
export const credentialPickupStatusResponse = z.object({
  state: credentialPickupStateSchema,
  systemName: z.string(),
  username: z.string(),
  expiresAt: z.string(),
});
export type CredentialPickupStatus = z.infer<typeof credentialPickupStatusResponse>;

/** `POST /api/credential-pickup/:token/reveal`, which answers this once per link. */
export const credentialPickupRevealResponse = z.object({
  username: z.string(),
  password: z.string(),
});

/**
 * Who an administrator's "Send login info" goes to. `profile` is the account
 * profile's own delivery setting; `admin` is the administrator pressing the
 * button, for a hand-over in person.
 */
export const sendLoginInfoRequest = z
  .object({
    recipient: z.enum(['profile', 'personalEmail', 'manager', 'admin']),
  })
  .strict();
export type SendLoginInfoRequest = z.infer<typeof sendLoginInfoRequest>;

export const sendLoginInfoResponse = z.object({
  pickupId: z.string().uuid(),
  recipientKind: z.enum(['personalEmail', 'manager', 'admin']),
  expiresAt: z.string(),
  revoked: z.number().int(),
  delivered: z.boolean(),
});

export const credentialPickupHistoryResponse = z.object({
  hasInitialSecret: z.boolean(),
  pickups: z.array(
    z.object({
      id: z.string().uuid(),
      recipientKind: z.string(),
      createdAt: z.string(),
      expiresAt: z.string(),
      viewedAt: z.string().nullable(),
      revokedAt: z.string().nullable(),
      createdByUserId: z.string().uuid().nullable(),
      state: credentialPickupStateSchema,
    }),
  ),
});
