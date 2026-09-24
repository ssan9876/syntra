import { z } from 'zod';

/**
 * Credential lifecycle (backlog #34, #67) and the security notification policy
 * (backlog #52).
 *
 * Every body is `.strict()`: a misspelled `declaredExpiresAt` that came back
 * 200 with nothing changed is an expiry nobody is ever warned about.
 */

/** `<kind>.<uuid>[.<hex>]`, the inventory's stable key for one credential. */
export const credentialKeyParam = z
  .object({
    key: z
      .string()
      .max(160)
      .regex(/^[a-z_]+\.[0-9a-f-]{36}(\.[0-9a-f]{16,64})?$/, 'not a credential key'),
  })
  .strict();

const instant = z.string().datetime({ offset: true });

export const credentialMetadataRequest = z
  .object({
    /** Null clears the owner. */
    ownerUserId: z.string().uuid().nullable().optional(),
    /**
     * An expiry the issuer does not publish to Syntra: an LDAP service
     * account's password policy, an Entra secret without Application.Read.All.
     * Refused for a credential that carries its own expiry. Null clears it.
     */
    declaredExpiresAt: instant.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type CredentialMetadataRequest = z.infer<typeof credentialMetadataRequest>;

export const credentialScanRequest = z
  .object({
    /** Ask Entra again even if it refused within the last week. */
    forceDiscovery: z.boolean().default(false),
  })
  .strict();

export const rotationSystemKinds = ['target', 'source', 'person_source'] as const;

export const stageRotationRequest = z
  .object({
    systemKind: z.enum(rotationSystemKinds),
    systemId: z.string().uuid(),
    /** The NEW secret, already created at the issuer beside the old one. Never echoed. */
    secret: z.string().min(1).max(16384),
    /** When the new secret expires at the issuer, if it does. Becomes the declared expiry at cut-over. */
    newExpiresAt: instant.nullable().optional(),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type StageRotationRequest = z.infer<typeof stageRotationRequest>;

export const rotationListQuery = z
  .object({
    systemKind: z.enum(rotationSystemKinds).optional(),
    systemId: z.string().uuid().optional(),
    open: z.enum(['true', 'false']).optional(),
  })
  .strict();

/**
 * Kept in step with `SECURITY_NOTIFICATION_CATEGORY_KEYS` in `@syntra/core`
 * and with the database CHECK; a test in `apps/api` asserts the three agree.
 */
export const securityNotificationCategories = [
  'credential_changes',
  'privileged_role_grants',
  'data_exports',
  'write_stops',
  'suspicious_authentication',
  'credential_expiry',
] as const;

export const securityNotificationSettingsRequest = z
  .object({
    emailCategories: z.array(z.enum(securityNotificationCategories)).max(securityNotificationCategories.length).optional(),
    /** Days before expiry to warn at. One to eight distinct values, each 1..365. */
    alertDays: z.array(z.number().int().min(1).max(365)).min(1).max(8).optional(),
  })
  .strict();
export type SecurityNotificationSettingsRequest = z.infer<typeof securityNotificationSettingsRequest>;
