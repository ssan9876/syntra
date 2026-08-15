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
});
export type TenantSettingsRequest = z.infer<typeof tenantSettingsRequest>;
