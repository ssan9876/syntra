import { describe, expect, it } from 'vitest';
import { anchorSearchValue, normaliseAnchor } from './anchor.js';

describe('normaliseAnchor', () => {
  it('renders an Active Directory objectGUID in canonical form', () => {
    // objectGUID is a raw 16-byte little-endian GUID. Microsoft tooling shows
    // it with the first three groups byte-reversed; matching that means an
    // administrator can paste an anchor from Syntra into AD and find the row.
    const raw = Buffer.from([
      0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a, 0xf0, 0xde, 0x11, 0x22, 0x33, 0x44,
      0x55, 0x66, 0x77, 0x88,
    ]);
    expect(normaliseAnchor('objectGUID', raw)).toBe(
      '12345678-9abc-def0-1122-334455667788',
    );
  });

  it('is stable across calls', () => {
    const raw = Buffer.from([
      0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a, 0xf0, 0xde, 0x11, 0x22, 0x33, 0x44,
      0x55, 0x66, 0x77, 0x88,
    ]);
    expect(normaliseAnchor('objectGUID', raw)).toBe(
      normaliseAnchor('objectGUID', raw),
    );
  });

  it('passes an OpenLDAP entryUUID through, lowercased', () => {
    expect(normaliseAnchor('entryUUID', '8A7B6C5D-1111-2222-3333-444455556666')).toBe(
      '8a7b6c5d-1111-2222-3333-444455556666',
    );
  });

  it('trims a text anchor', () => {
    expect(normaliseAnchor('entryUUID', '  abc-123  ')).toBe('abc-123');
  });

  it('rejects an objectGUID that is not 16 bytes', () => {
    expect(() => normaliseAnchor('objectGUID', Buffer.alloc(8))).toThrow(
      /16 bytes/,
    );
  });

  it('rejects an empty anchor rather than returning one', () => {
    // An empty anchor would collide with every other empty anchor and silently
    // merge unrelated people.
    expect(() => normaliseAnchor('entryUUID', '   ')).toThrow(/empty/i);
  });
});

describe('anchorSearchValue', () => {
  const raw = Buffer.from([
    0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a, 0xf0, 0xde, 0x11, 0x22, 0x33, 0x44,
    0x55, 0x66, 0x77, 0x88,
  ]);

  /**
   * The round trip is the whole test. A reversal applied in the wrong
   * direction still produces a perfectly valid sixteen-byte value -- it simply
   * names a DIFFERENT object, or none, and every write-back would then land on
   * whoever that turned out to be. Comparing against the original bytes is the
   * only assertion that catches it.
   */
  it('turns a normalised objectGUID back into the bytes it came from', () => {
    const anchor = normaliseAnchor('objectGUID', raw);
    expect(anchorSearchValue(anchor)).toEqual(raw);
  });

  it('returns a Buffer for a GUID anchor, not a string', () => {
    const value = anchorSearchValue(normaliseAnchor('objectGUID', raw));
    expect(Buffer.isBuffer(value)).toBe(true);
    expect(value).toHaveLength(16);
  });

  /** A text anchor (OpenLDAP's entryUUID) is matched as itself. */
  it('passes a text anchor through unchanged', () => {
    expect(anchorSearchValue('7c9e6679-7425-40de-944b-e07fc1f90ae7x')).toBe(
      '7c9e6679-7425-40de-944b-e07fc1f90ae7x',
    );
    expect(anchorSearchValue('abc')).toBe('abc');
  });

  it('does not mistake a non-GUID string for a GUID', () => {
    // Right shape, wrong alphabet: `g` is not hex.
    const notAGuid = 'gggggggg-9abc-def0-1122-334455667788';
    expect(anchorSearchValue(notAGuid)).toBe(notAGuid);
  });
});
