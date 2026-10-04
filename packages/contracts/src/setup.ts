import { z } from 'zod';
import { tenantHostname } from './tenant.js';

/**
 * First-run setup: the browser form that creates the first tenant and its
 * Owner on an install with no tenant at all.
 *
 * The token is the one the API printed to its log at startup: 32 random
 * bytes, base64url. Bounded and restricted to that alphabet so nothing else
 * reaches the comparison.
 */
export const setupToken = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/, 'Setup link is not valid');

/** `GET /api/setup?token=...`. */
export const setupStatusQuery = z.object({ token: setupToken }).strict();

/** What the setup page needs to render its form. */
export const setupStatusResponse = z.object({
  /** PUBLIC_URL's hostname, the form's suggested primary domain. */
  primaryDomain: z.string(),
  /** The shortest password the form accepts. */
  passwordMinLength: z.number().int(),
  /** When the setup link stops working. */
  expiresAt: z.string(),
});
export type SetupStatus = z.infer<typeof setupStatusResponse>;

/**
 * A tenant slug: one DNS label, because a hostname whose leftmost label is
 * the slug resolves to the tenant.
 */
export const tenantSlug = z
  .string()
  .trim()
  .toLowerCase()
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Lowercase letters, digits and hyphens only');

/** `POST /api/setup`. */
export const setupRequest = z
  .object({
    token: setupToken,
    organizationName: z.string().trim().min(1, 'Required').max(200),
    slug: tenantSlug,
    primaryDomain: tenantHostname,
    adminEmail: z.string().trim().toLowerCase().max(320).email('Not an email address'),
    adminDisplayName: z.string().trim().min(1, 'Required').max(256),
    password: z.string().min(1, 'Required').max(1024),
  })
  .strict();
export type SetupRequest = z.infer<typeof setupRequest>;

export const setupResponse = z.object({
  /** What the new Owner signs in with: the admin email. */
  login: z.string(),
  /** Where to sign in: the primary domain, on PUBLIC_URL's scheme. */
  signInUrl: z.string(),
});
export type SetupResponse = z.infer<typeof setupResponse>;
