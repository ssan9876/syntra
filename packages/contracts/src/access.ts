import { z } from 'zod';
import { isLaunchableUrl } from './launchable-url.js';

export { isLaunchableUrl };

export const applicationSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens');

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
   * Optional for a SAML application, and what it means depends on that
   * application's `allowIdpInitiated`. With IdP-initiated sign-in ON the tile
   * starts the sign-in at Syntra's own /saml/start and this is unused. With
   * it OFF — the secure default — the tile opens THIS address and the
   * application starts SP-initiated SSO from it, so it should be the
   * application's SSO start page; with none recorded the launch answers 409
   * `not-launchable` saying so. See the launch route in
   * apps/api/src/routes/portal.ts.
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

/**
 * Deleting an application: the administrator types its name.
 *
 * A body rather than `?confirm=true` (the target and source deletes' shape)
 * because what is being confirmed is not "yes" but WHICH application: two
 * tabs, two applications called nearly the same thing, and a boolean confirms
 * whichever one the URL happens to name. The server compares this against the
 * stored name, so a console bug cannot confirm on the reader's behalf.
 */
export const deleteApplicationRequest = z.object({
  confirm: z.string().max(256),
});
export type DeleteApplicationRequest = z.infer<typeof deleteApplicationRequest>;

export const deleteApplicationResponse = z.object({
  deleted: z.object({
    id: z.string().uuid(),
    name: z.string(),
    assignments: z.number().int(),
  }),
});
export type DeleteApplicationResponse = z.infer<typeof deleteApplicationResponse>;

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
    variables: z.record(z.string(), z.string().trim().max(512)).default({}),
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
