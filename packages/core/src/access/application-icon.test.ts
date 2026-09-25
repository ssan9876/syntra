import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_APP_ICON_BYTES } from '@syntra/contracts';
import {
  ApplicationIconRefusedError,
  decodeAppIconDataUri,
  isSameOriginIconPath,
  portalTileIconUrl,
  sniffAppIconType,
  toApplicationIconView,
} from './application-icon.js';

/**
 * The upload checks, without a database. These are the refusals that stand
 * between an administrator's file and every employee's browser, so each one
 * is pinned here directly rather than only through the route.
 */

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (size = 64) => Buffer.from([...PNG_HEADER, ...new Array<number>(size - PNG_HEADER.length).fill(0)]);
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const uri = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;

const refusal = (dataUri: string): string => {
  try {
    decodeAppIconDataUri(dataUri);
  } catch (cause) {
    expect(cause).toBeInstanceOf(ApplicationIconRefusedError);
    return (cause as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('sniffAppIconType', () => {
  it('recognises each accepted format by its own signature', () => {
    expect(sniffAppIconType(png())).toBe('image/png');
    expect(sniffAppIconType(jpeg())).toBe('image/jpeg');
    expect(sniffAppIconType(webp())).toBe('image/webp');
  });

  it('recognises nothing else', () => {
    expect(sniffAppIconType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffAppIconType(Buffer.from('GIF89a'))).toBeNull();
    // A RIFF that is not WebP — a WAV file, say.
    expect(sniffAppIconType(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '))).toBeNull();
    expect(sniffAppIconType(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('decodeAppIconDataUri', () => {
  it('accepts a PNG, JPEG and WebP and hashes the decoded bytes', () => {
    const bytes = png();
    const decoded = decodeAppIconDataUri(uri('image/png', bytes));
    expect(decoded.contentType).toBe('image/png');
    expect(decoded.bytes.equals(bytes)).toBe(true);
    expect(decoded.hash).toBe(createHash('sha256').update(bytes).digest('hex'));

    expect(decodeAppIconDataUri(uri('image/jpeg', jpeg())).contentType).toBe('image/jpeg');
    expect(decodeAppIconDataUri(uri('image/webp', webp())).contentType).toBe('image/webp');
  });

  it('accepts a media type in any case', () => {
    expect(decodeAppIconDataUri(uri('IMAGE/PNG', png())).contentType).toBe('image/png');
  });

  it('refuses SVG by name, with the reason', () => {
    const message = refusal(uri('image/svg+xml', Buffer.from('<svg/>')));
    expect(message).toMatch(/SVG/);
    expect(message).toMatch(/script/);
  });

  it('refuses markup labelled as a raster', () => {
    const message = refusal(uri('image/png', Buffer.from('<svg onload="alert(1)"/>')));
    expect(message).toMatch(/markup/);
  });

  it('refuses a file whose content does not match its label, naming both', () => {
    const message = refusal(uri('image/png', jpeg()));
    expect(message).toMatch(/labelled PNG/);
    expect(message).toMatch(/JPEG/);
  });

  it('refuses a file that is no image at all', () => {
    expect(refusal(uri('image/webp', Buffer.from('hello world, not a picture')))).toMatch(/labelled WebP but is not one/);
  });

  it('refuses a type outside the three', () => {
    expect(refusal(uri('image/gif', Buffer.from('GIF89a')))).toMatch(/PNG, JPEG, WebP/);
  });

  it('refuses a data URI that is not base64', () => {
    expect(refusal(`data:image/png,${encodeURIComponent('abc')}`)).toMatch(/base64/);
  });

  it('refuses a remote URL', () => {
    expect(refusal('https://cdn.example.com/logo.png')).toMatch(/hosts itself/);
  });

  it('refuses damaged base64 rather than decoding what it can', () => {
    expect(refusal('data:image/png;base64,iVBOR*w0KGgo=')).toMatch(/encoding is damaged/);
  });

  it('measures the limit on the DECODED size', () => {
    // Exactly at the limit is accepted, although its base64 is a third longer.
    expect(decodeAppIconDataUri(uri('image/png', png(MAX_APP_ICON_BYTES))).bytes.length).toBe(MAX_APP_ICON_BYTES);
    expect(refusal(uri('image/png', png(MAX_APP_ICON_BYTES + 1)))).toMatch(/limit is 64 KB/);
  });
});

describe('toApplicationIconView and the portal tile', () => {
  const base = { id: 'a1b2', iconKey: null, iconType: null, iconSize: null, iconHash: null, iconUrl: null };
  const hash = 'abcdef0123456789'.repeat(4);

  it('reports a built-in mark at its static path', () => {
    expect(toApplicationIconView({ ...base, iconKey: 'calendar' })).toEqual({
      kind: 'builtin',
      key: 'calendar',
      url: '/app-icons/calendar.svg',
    });
  });

  it('reports an upload at the API path, versioned by its hash', () => {
    expect(toApplicationIconView({ ...base, iconType: 'image/png', iconSize: 812, iconHash: hash })).toEqual({
      kind: 'image',
      url: '/api/portal/applications/a1b2/icon?v=abcdef012345',
      contentType: 'image/png',
      bytes: 812,
    });
  });

  it('reports a key this build does not ship as no icon', () => {
    expect(toApplicationIconView({ ...base, iconKey: 'not-a-key' })).toBeNull();
  });

  it('gives a tile the self-hosted logo over a legacy URL', () => {
    expect(portalTileIconUrl({ ...base, iconKey: 'mail', iconUrl: '/legacy.png' })).toBe('/app-icons/mail.svg');
  });

  it('keeps a legacy same-origin path and drops a remote one', () => {
    expect(portalTileIconUrl({ ...base, iconUrl: '/static/crm.png' })).toBe('/static/crm.png');
    expect(portalTileIconUrl({ ...base, iconUrl: 'https://cdn.example.com/crm.png' })).toBeNull();
    expect(portalTileIconUrl(base)).toBeNull();
  });

  it('treats protocol-relative paths as the other origin they are', () => {
    expect(isSameOriginIconPath('//cdn.example.com/x.png')).toBe(false);
    expect(isSameOriginIconPath('/\\cdn.example.com/x.png')).toBe(false);
    expect(isSameOriginIconPath('/x.png')).toBe(true);
  });
});
