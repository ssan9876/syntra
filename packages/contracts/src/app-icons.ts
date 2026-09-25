import { z } from 'zod';
import {
  APP_ICON_IMAGE_TYPES,
  BUILTIN_APP_ICONS,
  MAX_APP_ICON_BYTES,
  type ApplicationIconView,
} from './app-icon-keys.js';

export * from './app-icon-keys.js';

/**
 * `PUT /api/admin/applications/:id/icon`.
 *
 * `null` clears the logo and the tile goes back to its monogram. Setting one
 * also clears a legacy remote `iconUrl`, which the browser was never allowed
 * to load.
 */
export const applicationIconRequest = z.object({
  icon: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('builtin'), key: z.enum(BUILTIN_APP_ICONS) }).strict(),
      z
        .object({
          kind: z.literal('image'),
          /** `data:image/png;base64,...` — decoded and checked by the server. */
          dataUri: z.string().max(Math.ceil((MAX_APP_ICON_BYTES * 4) / 3) + 64),
        })
        .strict(),
    ])
    .nullable(),
}).strict();
export type ApplicationIconRequest = z.infer<typeof applicationIconRequest>;

/**
 * The logo as the API reports it, on the admin application record and in the
 * PUT response. `url` is always same-origin and safe to put in an `<img>`.
 */
export const applicationIconView = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin'), key: z.enum(BUILTIN_APP_ICONS), url: z.string() }),
    z.object({ kind: z.literal('image'), url: z.string(), contentType: z.enum(APP_ICON_IMAGE_TYPES), bytes: z.number().int() }),
  ])
  .nullable();
// The exported `ApplicationIconView` type lives in `app-icon-keys.ts`; this
// line fails to compile if the schema and that type ever disagree.
const _viewMatches: z.infer<typeof applicationIconView> extends ApplicationIconView ? true : never = true;
void _viewMatches;
