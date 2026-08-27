import { z } from 'zod';

export const applicationSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens');

/**
 * Whether a URL is an http(s) launch target the portal may send a browser to.
 *
 * `z.string().url()` alone is not enough: the WHATWG URL parser accepts any
 * scheme, so `javascript:alert(1)` passes it as happily as
 * `https://crm.acme.test/`. This is the URL the portal navigates a signed-in
 * user's browser to when they click the tile, so an unrestricted scheme is a
 * stored XSS vector, not just a validation nicety. Bookmarks only ever launch
 * over the web, so http(s) is the whole legitimate set.
 *
 * Exported so the launch route can re-check it on the way out, not just the
 * admin API on the way in — a row can predate this check (an older
 * migration, a seed script, a restore from before it existed), and trusting
 * storage because a schema exists somewhere is exactly the gap that lets a
 * stale `javascript:` URL reach a browser.
 */
export function isLaunchableUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Every URL this API accepts for an application, whether the browser will
 * navigate to it or render it.
 *
 * One schema for both, because the reason is one reason. `z.string().url()`
 * accepts `javascript:` as readily as `https:`, and the difference between a
 * launch target and an icon source is only which sink the value reaches — an
 * `<img src>` today, an `<a href>` or a CSS `url()` the first time somebody
 * builds a richer tile. `iconUrl` sat one line above the hardened `launchUrl`
 * with the weaker check, plumbed all the way through to the web `Tile` type;
 * the second field is not the safe one, it is only the one nothing renders
 * yet.
 */
const webUrl = z
  .string()
  .max(2048)
  .refine(isLaunchableUrl, { message: 'Must be an http or https URL' });

/**
 * The fields, separate from the refinement below.
 *
 * `.refine()` produces a `ZodEffects`, which has no `.partial()`, and
 * `updateApplicationRequest` needs one. Keeping the shape addressable is the
 * whole reason this is a named object rather than an inline literal.
 */
const applicationFields = z.object({
  name: z.string().min(1).max(128),
  slug: applicationSlug,
  description: z.string().max(1024).optional(),
  iconUrl: webUrl.optional(),
  // Access I launched bookmarks only. Access II widens this: the column has
  // always been a free string, so it is a code change and not a migration.
  type: z.enum(['bookmark', 'saml', 'oidc']).default('bookmark'),
  /**
   * Where the browser is sent.
   *
   * Required for a bookmark, and required for an OIDC application too — an
   * OpenID Connect relying party has no identity-provider-initiated flow in
   * the standard, because only the relying party knows its own `state`,
   * `nonce` and PKCE verifier, so launching one means sending the browser to
   * the application's own start address and letting it begin the code flow.
   *
   * Meaningless for a SAML application, whose launch address is derived from
   * the tenant's own protocol identity and never stored.
   */
  launchUrl: webUrl.optional(),
  /**
   * The heading this tile appears under in the portal.
   *
   * Nullable as well as optional: absent means "leave it alone" on an update,
   * and `null` means "put it back under the general heading". A field that
   * could only be set and never cleared would make the first typo permanent.
   */
  category: z.string().trim().max(64).nullable().optional(),
  visibility: z.enum(['assigned', 'hidden']).default('assigned'),
});

export const createApplicationRequest = applicationFields.refine(
  (value) => value.type === 'saml' || value.launchUrl !== undefined,
  {
    message: 'This application needs a launch URL',
    path: ['launchUrl'],
  },
);
export type CreateApplicationRequest = z.input<typeof createApplicationRequest>;

export const updateApplicationRequest = applicationFields
  .partial()
  .omit({ slug: true })
  .extend({ status: z.enum(['active', 'inactive']).optional() });
export type UpdateApplicationRequest = z.input<typeof updateApplicationRequest>;

export const assignApplicationRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: z.string().uuid() }),
  z.object({ type: z.literal('group'), id: z.string().uuid() }),
  z.object({ type: z.literal('orgUnit'), id: z.string().uuid() }),
]);
export type AssignApplicationRequest = z.infer<typeof assignApplicationRequest>;

export const assignmentParams = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
});

export const applicationTile = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  /** The heading this tile appears under. Null groups it with the rest. */
  category: z.string().nullable(),
});
export type ApplicationTile = z.infer<typeof applicationTile>;

/**
 * The application catalog: known service providers, with their SSO settings
 * already filled in.
 *
 * Only the request is validated here. The catalog itself is a constant in
 * `@syntra/core` and is served as it is — a hand-kept parallel schema for a
 * static list would be a second definition to drift from the first, and there
 * is no untrusted input on that side to check.
 */
export const catalogCreateRequest = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/, 'A catalog key'),
    /**
     * What the administrator supplied for the entry's variables.
     *
     * Bounded on both sides: these land in entity IDs and assertion consumer
     * URLs, which are compared byte for byte at sign-in. The service refuses a
     * blank one — see `fill` — so this only has to stop an oversized body.
     */
    variables: z.record(z.string().trim().max(512)).default({}),
    /** Overrides the entry's own name, for a second instance of one. */
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const catalogCreateResponse = z.object({
  applicationId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  protocol: z.enum(['saml', 'oidc', 'bookmark']),
  clientId: z.string().optional(),
  /** Returned once. There is no route that reads it back. */
  clientSecret: z.string().optional(),
});

export type CatalogCreateRequest = z.infer<typeof catalogCreateRequest>;
export type CatalogCreateResponse = z.infer<typeof catalogCreateResponse>;
