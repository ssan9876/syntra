import { z } from 'zod';

/**
 * The tenant settings the console may change.
 *
 * `slug` and `primaryDomain` are deliberately absent. The first is how a
 * request is routed to this tenant; the second is what a security key's
 * relying party is derived from, so changing it invalidates every credential
 * registered against the old value. Both are operator decisions made against a
 * runbook, not checkboxes — and a field that is not in the schema cannot be
 * written by a body that mentions it.
 */
export const tenantSettingsRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  adminMfaRequired: z.boolean().optional(),
  selfEnrolmentEnabled: z.boolean().optional(),
  // The floor the password policy enforces. The lower bound is the product's,
  // not the tenant's: a tenant that could set four would have no policy at all.
  passwordMinLength: z.number().int().min(12).max(128).optional(),
  /**
   * A bare hostname: no scheme, no port, no path. Lower-cased on the way in,
   * because `resolveTenantId` lower-cases the Host header before comparing and
   * a stored `Acme.Example.Com` would simply never match.
   *
   * The pattern accepts an IP address as well as a domain, and that is not an
   * accident: the resolver does a plain string comparison against the
   * hostname, so `192.168.1.10` is a perfectly good primary domain for an
   * instance reached that way. Refusing it would be inventing a rule the
   * product does not have.
   *
   * Nullable clears it, which turns WebAuthn off for the tenant.
   */
  primaryDomain: z
    .string()
    .max(253)
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
      'A hostname only — no scheme, port or path',
    )
    .nullable()
    .optional(),
  /**
   * How many registered passkeys the caller was told this would break.
   *
   * Checked against the live count rather than trusted: a key enrolled between
   * the warning and the confirmation must not be swept into a decision nobody
   * made about it. Absent means "I have not been warned yet", which is what
   * produces the 409.
   */
  ackPasskeys: z.number().int().min(0).optional(),
});
export type TenantSettingsRequest = z.infer<typeof tenantSettingsRequest>;
