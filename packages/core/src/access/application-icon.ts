import { createHash } from 'node:crypto';
import type { Prisma, TenantClient } from '@syntra/db';
import {
  APP_ICON_IMAGE_TYPES,
  BUILTIN_APP_ICONS,
  MAX_APP_ICON_BYTES,
  builtinAppIconPath,
  type ApplicationIconRequest,
  type ApplicationIconView,
  type BuiltinAppIcon,
} from '@syntra/contracts';

/**
 * An application's logo: a built-in mark, or a small raster an administrator
 * uploaded, stored on the row and served from this origin.
 *
 * Hosted here because it has to be. The page's security policy allows images
 * only from `'self' data: blob:`, so a vendor's logo URL was a request the
 * browser refused — every remote `iconUrl` has always been a monogram. The
 * fix is not to loosen the policy (a logo that fetches from elsewhere is a
 * beacon reporting who opened the portal and when) but to bring the picture
 * home.
 *
 * The upload is checked harder than its size suggests, in the same spirit as
 * the sign-in logo (`brand-service.ts`): the bytes are served back to every
 * employee's browser from THIS origin, so an upload that is not what it says
 * it is — an SVG with script in it, HTML labelled as a PNG — is stored
 * cross-site scripting with our name on it. So: base64 only, three raster
 * types only, a decoded size limit, and the magic bytes must agree with the
 * declared type. The serving route adds `nosniff` and `default-src 'none'`
 * as the second belt.
 */

export type AppIconImageType = (typeof APP_ICON_IMAGE_TYPES)[number];

/** A refusal the administrator can act on. The route answers 400 with it. */
export class ApplicationIconRefusedError extends Error {}

/**
 * Where the API serves an uploaded logo.
 *
 * Under `/api/portal` rather than `/api/admin` because the reader is every
 * signed-in employee looking at their tiles, not only an administrator — and
 * a portal-scoped route accepts an admin session too, so the console draws
 * the same URL. It has to sit under a server prefix (`SERVER_PATH_PREFIXES`,
 * the web dev proxy) or the single-page app would answer it with index.html.
 */
export function uploadedAppIconPath(applicationId: string): string {
  return `/api/portal/applications/${applicationId}/icon`;
}

/**
 * The first 12 hex characters of the content hash, as `?v=`. Enough to make
 * a collision between two pictures of one application irrelevant, short
 * enough not to clutter a URL. The response is cached as immutable, so a new
 * picture MUST be a new URL — that is all this is for.
 */
export const ICON_VERSION_LENGTH = 12;

const DATA_URI_HEAD = /^data:([^,]*),/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const TYPE_NAMES: Record<AppIconImageType, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
};

const ALLOWED = `${Object.values(TYPE_NAMES).join(', ')}`;

/**
 * What the bytes actually are, from their first few, or null.
 *
 * The signatures are the formats' own: PNG's eight-byte header, JPEG's SOI
 * marker followed by the first segment's `FF`, and WebP's RIFF container with
 * `WEBP` at offset 8. Nothing looser: a file that does not open with its own
 * signature is not one a browser will draw as that type anyway.
 */
export function sniffAppIconType(bytes: Uint8Array): AppIconImageType | null {
  const at = (offset: number, signature: readonly number[]) =>
    bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value);

  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // "RIFF", four bytes of length, "WEBP".
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/** Whether the bytes look like markup — an SVG or HTML dressed as a raster. */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  // `trimStart` also drops a byte-order mark: U+FEFF is whitespace to JavaScript.
  const head = Buffer.from(bytes.subarray(0, 256)).toString('utf8').trimStart();
  return head.startsWith('<');
}

export interface DecodedAppIcon {
  contentType: AppIconImageType;
  bytes: Buffer;
  /** SHA-256 of `bytes`, hex. */
  hash: string;
}

/**
 * Parses and checks an uploaded logo's data URI. Pure: no database, so the
 * refusals are tested directly (`application-icon.test.ts`).
 *
 * Every refusal says what was wrong and what would be accepted, because the
 * administrator is holding the file and "invalid image" sends them back to
 * guessing.
 */
export function decodeAppIconDataUri(dataUri: string): DecodedAppIcon {
  const head = DATA_URI_HEAD.exec(dataUri);
  if (!head) {
    throw new ApplicationIconRefusedError(
      `A logo must be uploaded as an image file (${ALLOWED}). A link to a logo on another site cannot be shown here: the portal only displays pictures it hosts itself.`,
    );
  }
  const [, meta = ''] = head as unknown as [string, string];
  const parameters = meta.split(';').map((part) => part.trim().toLowerCase());
  const mediaType = parameters[0] ?? '';

  // Named first and on its own, because it is the one people try and the
  // reason is not obvious: an SVG is a document, and can carry script.
  if (mediaType === 'image/svg+xml') {
    throw new ApplicationIconRefusedError(
      `SVG logos are not accepted: an SVG can carry script, and this picture is shown to everyone in your organisation. Export it as ${ALLOWED} instead.`,
    );
  }
  if (!(APP_ICON_IMAGE_TYPES as readonly string[]).includes(mediaType)) {
    throw new ApplicationIconRefusedError(
      `A logo may be ${ALLOWED}. ${mediaType ? `That file is ${mediaType}.` : 'That file did not say what type it is.'}`,
    );
  }
  const declared = mediaType as AppIconImageType;

  if (!parameters.slice(1).includes('base64')) {
    throw new ApplicationIconRefusedError(
      'The logo must be sent base64-encoded. Choose the file again; if this keeps happening, the page that sent it is out of date.',
    );
  }

  const payload = dataUri.slice(head[0].length);
  if (payload.length === 0) {
    throw new ApplicationIconRefusedError('That file is empty.');
  }
  // Strict, because `Buffer.from(…, 'base64')` is not: it skips characters it
  // does not recognise, so a payload with junk in it would decode to
  // something, and the size and signature checks would be checking that.
  if (payload.length % 4 !== 0 || !BASE64.test(payload)) {
    throw new ApplicationIconRefusedError(
      'The logo could not be read: its encoding is damaged. Choose the file again.',
    );
  }

  const bytes = Buffer.from(payload, 'base64');
  // The DECODED size, not the string's. Base64 inflates by a third, and
  // refusing at the encoded length would turn away a logo within the limit.
  if (bytes.length > MAX_APP_ICON_BYTES) {
    throw new ApplicationIconRefusedError(
      `That logo is ${Math.ceil(bytes.length / 1024)} KB. The limit is ${MAX_APP_ICON_BYTES / 1024} KB — a tile draws it at 40 pixels, so a small square image is plenty.`,
    );
  }

  const actual = sniffAppIconType(bytes);
  if (actual === null) {
    if (looksLikeMarkup(bytes)) {
      throw new ApplicationIconRefusedError(
        `That file is not a ${TYPE_NAMES[declared]} image: it contains markup, like an SVG or a web page. Upload a ${ALLOWED} image instead.`,
      );
    }
    throw new ApplicationIconRefusedError(
      `That file is labelled ${TYPE_NAMES[declared]} but is not one. Open it in an image editor and export it as ${ALLOWED}.`,
    );
  }
  // Refused rather than silently relabelled. A mismatch is usually a renamed
  // file and harmless, but "the label lies" is also exactly the shape of the
  // attack the check exists for, and serving what we checked — not what we
  // were told — only works if the two agree.
  if (actual !== declared) {
    throw new ApplicationIconRefusedError(
      `That file is labelled ${TYPE_NAMES[declared]} but is actually a ${TYPE_NAMES[actual]}. Rename it with the right extension, or export it again, and upload it once more.`,
    );
  }

  return { contentType: declared, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * The icon columns, as every read of an application carries them. The bytes
 * themselves are not among them: see `APPLICATION_OMIT` in
 * `application-service.ts`.
 */
export interface ApplicationIconColumns {
  id: string;
  iconKey: string | null;
  iconType: string | null;
  iconSize: number | null;
  iconHash: string | null;
}

function isBuiltin(key: string): key is BuiltinAppIcon {
  return (BUILTIN_APP_ICONS as readonly string[]).includes(key);
}

function isImageType(type: string): type is AppIconImageType {
  return (APP_ICON_IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * The logo as the API reports it. Null when there is none — including a key
 * this build does not ship (a row written by a newer release and read by an
 * older one), which draws the monogram rather than a broken image.
 */
export function toApplicationIconView(row: ApplicationIconColumns): ApplicationIconView {
  if (row.iconKey !== null) {
    if (!isBuiltin(row.iconKey)) return null;
    return { kind: 'builtin', key: row.iconKey, url: builtinAppIconPath(row.iconKey) };
  }
  if (row.iconHash !== null && row.iconType !== null && isImageType(row.iconType)) {
    return {
      kind: 'image',
      url: `${uploadedAppIconPath(row.id)}?v=${row.iconHash.slice(0, ICON_VERSION_LENGTH)}`,
      contentType: row.iconType,
      bytes: row.iconSize ?? 0,
    };
  }
  return null;
}

/**
 * Whether a legacy `iconUrl` could ever render: a path on this origin.
 *
 * Starting with `/` is not enough on its own — `//cdn.example` and `/\cdn`
 * are both read by a browser as another host.
 */
export function isSameOriginIconPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\');
}

/**
 * What a portal tile draws: the self-hosted logo when there is one, else a
 * legacy `iconUrl` only if it is on this origin.
 *
 * A remote legacy URL comes back null rather than as itself. The browser was
 * never going to load it, and handing it over costs every employee a refused
 * request and a console error per tile before the monogram appears anyway.
 */
export function portalTileIconUrl(row: ApplicationIconColumns & { iconUrl: string | null }): string | null {
  const icon = toApplicationIconView(row);
  if (icon !== null) return icon.url;
  if (row.iconUrl !== null && isSameOriginIconPath(row.iconUrl)) return row.iconUrl;
  return null;
}

/**
 * Sets or clears an application's logo. Returns the new view, or `undefined`
 * when there is no such application in this tenant.
 *
 * All five icon columns are written on every call, together with `iconUrl`:
 * a built-in mark clears an upload, an upload clears a mark, and either — or
 * clearing — drops the legacy remote URL, which the browser was never allowed
 * to load and would otherwise resurface the moment the new logo was removed.
 */
export async function setApplicationIcon(
  tx: TenantClient,
  applicationId: string,
  icon: ApplicationIconRequest['icon'],
): Promise<{ icon: ApplicationIconView; slug: string; hash: string | null } | undefined> {
  // Existence first, then the file: a 404 for an application that does not
  // exist is the truer answer whatever the body said.
  const existing = await tx.application.findUnique({ where: { id: applicationId }, select: { id: true } });
  if (!existing) return undefined;

  const cleared = { iconUrl: null, iconKey: null, iconImage: null, iconType: null, iconSize: null, iconHash: null };
  let data: Prisma.ApplicationUpdateInput = cleared;

  if (icon?.kind === 'builtin') {
    data = { ...cleared, iconKey: icon.key };
  } else if (icon?.kind === 'image') {
    const decoded = decodeAppIconDataUri(icon.dataUri);
    data = {
      ...cleared,
      // A copy into a plain ArrayBuffer-backed array: Prisma's `Bytes` input
      // is `Uint8Array<ArrayBuffer>`, and a Node Buffer may be a view onto the
      // shared pool.
      iconImage: new Uint8Array(decoded.bytes),
      iconType: decoded.contentType,
      iconSize: decoded.bytes.length,
      iconHash: decoded.hash,
    };
  }

  const updated = await tx.application.update({
    where: { id: applicationId },
    data,
    select: { id: true, slug: true, iconKey: true, iconType: true, iconSize: true, iconHash: true },
  });
  return { icon: toApplicationIconView(updated), slug: updated.slug, hash: updated.iconHash };
}

/**
 * The stored picture, for the route that serves it. Null when the
 * application does not exist in this tenant or has no uploaded image — the
 * route answers both with the same 404.
 */
export async function readApplicationIconImage(
  tx: TenantClient,
  applicationId: string,
): Promise<{ bytes: Uint8Array; contentType: AppIconImageType; hash: string } | null> {
  const row = await tx.application.findUnique({
    where: { id: applicationId },
    select: { iconImage: true, iconType: true, iconHash: true },
  });
  if (!row?.iconImage || !row.iconType || !row.iconHash || !isImageType(row.iconType)) return null;
  return { bytes: row.iconImage, contentType: row.iconType, hash: row.iconHash };
}
