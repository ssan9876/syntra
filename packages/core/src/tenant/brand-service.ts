import type { TenantClient } from '@syntra/db';

/**
 * What a tenant calls itself, and in what colours.
 *
 * Small, and guarded harder than its size suggests. Everything here renders on
 * the SIGN-IN page, which is the one screen a user sees before they have
 * authenticated and the one screen an attacker would most like to control.
 * So: no remote URLs (a logo that fetches is a logo that reports who is
 * signing in and when), no SVG (it carries script), and no colour that cannot
 * be read against the page it sits on.
 */

export interface Brand {
  name: string | null;
  logo: string | null;
  primary: string | null;
  accent: string | null;
}

export class BrandRefusedError extends Error {}

/**
 * How large a logo may be, as a data URI.
 *
 * 256 KB, which is generous for a wordmark and mean for a photograph. The
 * limit exists because this string is served to every unauthenticated visitor
 * of the sign-in page, and the sign-in page must load on a bad connection.
 */
export const MAX_LOGO_BYTES = 256 * 1024;

/**
 * The image types a logo may be.
 *
 * SVG is absent DELIBERATELY and permanently. An SVG is a document: it can
 * carry `<script>`, `<foreignObject>`, and external references, and this one
 * would be rendered on the unauthenticated sign-in page of an identity
 * product. PNG covers every wordmark anybody has; the loss is a few kilobytes
 * and the gain is that the logo cannot execute.
 */
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/;

export function assertLogoUsable(logo: string): void {
  const match = DATA_URI.exec(logo);
  if (!match) {
    throw new BrandRefusedError(
      'A logo must be a base64 data URI. A logo loaded from a URL stops working the day that URL moves, and this page has to render when nothing else is reachable.',
    );
  }
  const [, mediaType, payload] = match as unknown as [string, string, string];
  if (!(LOGO_TYPES as readonly string[]).includes(mediaType)) {
    throw new BrandRefusedError(
      `A logo may be ${LOGO_TYPES.join(', ')}. SVG is not accepted: it can carry script, and this renders before anybody has signed in.`,
    );
  }
  // The decoded length, not the string's. Base64 inflates by a third, and
  // refusing at the encoded size would reject a logo that is within the limit.
  const bytes = Math.floor((payload.length * 3) / 4);
  if (bytes > MAX_LOGO_BYTES) {
    throw new BrandRefusedError(
      `That logo is ${Math.round(bytes / 1024)} KB. The limit is ${MAX_LOGO_BYTES / 1024} KB.`,
    );
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** sRGB relative luminance, per WCAG 2.1 §1.4.3. */
export function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [light, dark] = x > y ? [x, y] : [y, x];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The two page grounds a brand colour has to survive.
 *
 * Both themes, always — not whichever one the administrator happens to be
 * looking at. A colour checked against the light page and then rendered on the
 * dark one is a sign-in button nobody can see, and the person who picked it
 * will never be the person who finds out.
 */
export const GROUNDS = { light: '#ffffff', dark: '#0d1117' } as const;

/**
 * 3:1, the WCAG 1.4.11 threshold for a user interface component.
 *
 * Not 4.5:1. These colours paint buttons and focus rings, not body text, and
 * holding a brand to the text threshold would refuse most real brands for no
 * accessibility gain. Text drawn ON the primary colour is a separate problem,
 * solved by choosing black or white per colour rather than by constraining the
 * colour.
 */
export const MIN_CONTRAST = 3;

export function assertColourUsable(field: string, hex: string): void {
  if (!HEX.test(hex)) {
    throw new BrandRefusedError(`${field} must be a six-digit hex colour, like #2563eb.`);
  }
  for (const [theme, ground] of Object.entries(GROUNDS)) {
    const ratio = contrastRatio(hex, ground);
    if (ratio < MIN_CONTRAST) {
      throw new BrandRefusedError(
        `${hex} sits at ${ratio.toFixed(2)}:1 against the ${theme} page, below the ${MIN_CONTRAST}:1 a control needs. Pick a ${ratio === contrastRatio(hex, GROUNDS.light) ? 'darker' : 'lighter'} shade of the same colour.`,
      );
    }
  }
}

/**
 * Which of black or white to draw ON this colour.
 *
 * Computed rather than configured. A tenant choosing their own foreground gets
 * it wrong roughly half the time, and the failure is a button whose label
 * cannot be read — so the colour is theirs and the legibility is not.
 */
export function readableOn(hex: string): '#000000' | '#ffffff' {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff')
    ? '#000000'
    : '#ffffff';
}

export interface BrandInput {
  name?: string | null | undefined;
  logo?: string | null | undefined;
  primary?: string | null | undefined;
  accent?: string | null | undefined;
}

export async function setBrand(tx: TenantClient, input: BrandInput): Promise<Brand> {
  const name = input.name?.trim() ?? null;
  if (name !== null && name.length > 64) {
    throw new BrandRefusedError('A name longer than 64 characters will not fit the header.');
  }
  if (input.logo) assertLogoUsable(input.logo);
  if (input.primary) assertColourUsable('The primary colour', input.primary);
  if (input.accent) assertColourUsable('The accent colour', input.accent);

  const tenant = await tx.tenant.findFirstOrThrow();
  const updated = await tx.tenant.update({
    where: { id: tenant.id },
    data: {
      brandName: name === '' ? null : name,
      brandLogo: input.logo ?? null,
      brandPrimary: input.primary?.toLowerCase() ?? null,
      brandAccent: input.accent?.toLowerCase() ?? null,
    },
  });
  return toBrand(updated);
}

export async function readBrand(tx: TenantClient): Promise<Brand> {
  const tenant = await tx.tenant.findFirstOrThrow();
  return toBrand(tenant);
}

function toBrand(row: {
  brandName: string | null;
  brandLogo: string | null;
  brandPrimary: string | null;
  brandAccent: string | null;
}): Brand {
  return {
    name: row.brandName,
    logo: row.brandLogo,
    primary: row.brandPrimary,
    accent: row.brandAccent,
  };
}
