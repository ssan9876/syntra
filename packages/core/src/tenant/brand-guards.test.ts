import { describe, expect, it } from 'vitest';
import {
  BrandRefusedError,
  GROUNDS,
  MAX_LOGO_BYTES,
  assertColourUsable,
  assertLogoUsable,
  contrastRatio,
  readableOn,
} from './brand-service.js';

const dataUri = (type: string, bytes: number) =>
  `data:${type};base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`;

describe('assertLogoUsable', () => {
  it('takes a base64 PNG', () => {
    expect(() => assertLogoUsable(dataUri('image/png', 1024))).not.toThrow();
  });

  it('refuses a logo loaded from somewhere else', () => {
    // Two reasons, and the second is the one that matters: a logo that fetches
    // is a logo that tells its host who is signing in and when. The first is
    // that the sign-in page has to render when nothing else is reachable.
    expect(() => assertLogoUsable('https://cdn.example.test/logo.png')).toThrow(
      BrandRefusedError,
    );
  });

  it('refuses SVG', () => {
    // An SVG is a document, not an image: it carries script, foreignObject and
    // external references, and this renders on the unauthenticated sign-in
    // page of an identity product.
    expect(() => assertLogoUsable(dataUri('image/svg+xml', 512))).toThrow(/SVG/);
  });

  it('measures the decoded size, not the encoded one', () => {
    // Base64 inflates by a third. Measuring the string would refuse a logo
    // that is comfortably within the limit.
    expect(() => assertLogoUsable(dataUri('image/png', MAX_LOGO_BYTES - 1024))).not.toThrow();
    expect(() => assertLogoUsable(dataUri('image/png', MAX_LOGO_BYTES + 4096))).toThrow(/KB/);
  });
});

describe('assertColourUsable', () => {
  it('refuses anything that is not a six-digit hex', () => {
    expect(() => assertColourUsable('The primary colour', 'rebeccapurple')).toThrow(/hex/);
    expect(() => assertColourUsable('The primary colour', '#abc')).toThrow(/hex/);
  });

  it('takes a colour readable on both pages', () => {
    expect(() => assertColourUsable('The primary colour', '#2563eb')).not.toThrow();
  });

  it('refuses a colour that vanishes on the light page', () => {
    // Checked against BOTH grounds rather than whichever the administrator is
    // looking at. A colour picked on the dark console and rendered on the
    // light sign-in page is a button nobody can see, and the person who chose
    // it will never be the person who finds out.
    expect(() => assertColourUsable('The primary colour', '#fffbe6')).toThrow(/light page/);
  });

  it('refuses a colour that vanishes on the dark page', () => {
    expect(() => assertColourUsable('The primary colour', '#0e1a2b')).toThrow(/dark page/);
  });

  it('names the ratio it measured, so the refusal is actionable', () => {
    // "That colour is not allowed" sends somebody back to guessing. The number
    // and the direction to move in is the whole difference.
    expect(() => assertColourUsable('The accent colour', '#fffbe6')).toThrow(/:1/);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white, in either order', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });

  it('is 1:1 for a colour against itself', () => {
    expect(contrastRatio(GROUNDS.dark, GROUNDS.dark)).toBeCloseTo(1, 5);
  });
});

describe('readableOn', () => {
  it('picks the foreground rather than letting a tenant pick it', () => {
    // A tenant choosing their own foreground gets it wrong about half the
    // time, and the failure is a button whose label cannot be read. The colour
    // is theirs; the legibility is not.
    expect(readableOn('#111827')).toBe('#ffffff');
    expect(readableOn('#fde047')).toBe('#000000');
  });
});
