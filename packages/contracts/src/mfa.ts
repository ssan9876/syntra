import { z } from 'zod';

export const factorType = z.enum(['totp', 'webauthn']);
export const presentedFactorType = z.enum(['totp', 'webauthn', 'recovery_code']);

export const totpConfirmRequest = z.object({
  code: z.string().min(6).max(6),
});
export type TotpConfirmRequest = z.infer<typeof totpConfirmRequest>;

export const webauthnRegisterRequest = z.object({
  label: z.string().min(1).max(64).default('Security key'),
  // The browser's RegistrationResponseJSON. Its shape is the WebAuthn
  // specification's, not ours, and @simplewebauthn/server validates it far more
  // thoroughly than a zod object could; re-declaring it here would only drift.
  response: z.record(z.unknown()),
});
export type WebauthnRegisterRequest = z.input<typeof webauthnRegisterRequest>;

export const webauthnCredentialRemoveParams = z.object({
  credentialId: z.string().uuid(),
});

/**
 * The second half of a sign-in. Exactly one factor field is present, matched to
 * `type`, so a caller cannot send a TOTP code and hope it satisfies a WebAuthn
 * requirement.
 */
export const mfaVerifyRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('totp'),
    attemptToken: z.string().min(1).max(256),
    code: z.string().min(6).max(6),
  }),
  z.object({
    type: z.literal('recovery_code'),
    attemptToken: z.string().min(1).max(256),
    code: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('webauthn'),
    attemptToken: z.string().min(1).max(256),
    assertion: z.record(z.unknown()),
  }),
]);
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequest>;

export const webauthnChallengeRequest = z.object({
  attemptToken: z.string().min(1).max(256),
});

export const mfaStatusResponse = z.object({
  totp: z.object({ enrolled: z.boolean() }),
  webauthn: z.object({
    /**
     * Whether a security key can be registered on this address at all.
     *
     * Part of the contract rather than an undeclared extra on the wire: a
     * client that parses the response with this schema drops anything not
     * declared here, so leaving the field out would silently turn every
     * "security keys are unavailable, and here is why" answer back into an
     * enabled button that fails when pressed.
     */
    available: z.boolean(),
    unavailableReason: z.string().nullable(),
    credentials: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        createdAt: z.string(),
        lastUsedAt: z.string().nullable(),
      }),
    ),
  }),
  recoveryCodes: z.object({ remaining: z.number() }),
});
export type MfaStatusResponse = z.infer<typeof mfaStatusResponse>;

export const adminFactorParams = z.object({
  id: z.string().uuid(),
  type: presentedFactorType,
});
