import { z } from 'zod';

export const applicationSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens');

/**
 * `z.string().url()` alone is not enough here: the WHATWG URL parser accepts
 * any scheme, so `javascript:alert(1)` passes it as happily as
 * `https://crm.acme.test/`. This is the URL the portal navigates a signed-in
 * user's browser to when they click the tile, so an unrestricted scheme is a
 * stored XSS vector, not just a validation nicety. Bookmarks only ever launch
 * over the web, so http(s) is the whole legitimate set.
 */
const launchableUrl = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'Must be an http or https URL' },
  );

export const createApplicationRequest = z.object({
  name: z.string().min(1).max(128),
  slug: applicationSlug,
  description: z.string().max(1024).optional(),
  iconUrl: z.string().url().max(2048).optional(),
  // Access I launches bookmarks. Access II widens this enum; the column is
  // already a free string, so that is a code change and not a migration.
  type: z.literal('bookmark').default('bookmark'),
  launchUrl: launchableUrl,
  visibility: z.enum(['assigned', 'hidden']).default('assigned'),
});
export type CreateApplicationRequest = z.input<typeof createApplicationRequest>;

export const updateApplicationRequest = createApplicationRequest
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
});
export type ApplicationTile = z.infer<typeof applicationTile>;
