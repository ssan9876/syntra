import { describe, expect, it } from 'vitest';
import {
  assertAddressAllowed,
  compareHostKey,
  fingerprintOf,
  globToRegExp,
  isGlob,
} from './transport.js';

describe('fingerprintOf', () => {
  it('prints a SHA256 fingerprint the way OpenSSH does', () => {
    // SHA-256 of no bytes, base64, padding stripped.
    expect(fingerprintOf(Buffer.from(''))).toBe(
      'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU',
    );
  });
});

describe('compareHostKey', () => {
  it('reports unknown when nothing is stored', () => {
    expect(compareHostKey('SHA256:aaa', undefined)).toBe('unknown');
  });

  it('reports unknown when the stored value is empty', () => {
    expect(compareHostKey('SHA256:aaa', '')).toBe('unknown');
  });

  it('reports matched when the stored key is the presented one', () => {
    expect(compareHostKey('SHA256:aaa', 'SHA256:aaa')).toBe('matched');
  });

  /**
   * The state that must never be one click from `unknown`. A key that changed
   * is a rebuilt server or an interception, and only one of those is safe.
   */
  it('reports mismatch when a different key is stored', () => {
    expect(compareHostKey('SHA256:bbb', 'SHA256:aaa')).toBe('mismatch');
  });
});

describe('assertAddressAllowed', () => {
  it('refuses a name that resolves into a blocked range', async () => {
    await expect(assertAddressAllowed('localhost', false)).rejects.toThrow(
      /refuses to connect to/,
    );
  });

  it('returns the literal address when private addresses are allowed', async () => {
    await expect(assertAddressAllowed('localhost', true)).resolves.toMatch(
      /^(127\.0\.0\.1|::1)$/,
    );
  });
});

describe('isGlob', () => {
  it('treats a plain path as a literal file name', () => {
    expect(isGlob('/export/people.csv')).toBe(false);
  });

  it('recognises the two wildcards a file name ever needs', () => {
    expect(isGlob('/export/people-*.csv')).toBe(true);
    expect(isGlob('/export/people-?.csv')).toBe(true);
  });
});

describe('globToRegExp', () => {
  it('matches what the wildcard stands for', () => {
    const re = globToRegExp('people-*.csv');
    expect(re.test('people-2026-08-29.csv')).toBe(true);
    expect(re.test('people-.csv')).toBe(true);
  });

  /**
   * A dot in the pattern means a dot. Unescaped it would match any character,
   * so `people.csv` would also match `peopleXcsv` -- and a source that matched
   * two files is refused rather than guessing between them.
   */
  it('escapes regex characters rather than honouring them', () => {
    expect(globToRegExp('people.csv').test('peopleXcsv')).toBe(false);
    expect(globToRegExp('people.csv').test('people.csv')).toBe(true);
  });

  it('anchors, so a partial name does not match', () => {
    const re = globToRegExp('people-*.csv');
    expect(re.test('old-people-1.csv')).toBe(false);
    expect(re.test('people-1.csv.bak')).toBe(false);
  });

  it('does not let a wildcard cross a directory boundary', () => {
    expect(globToRegExp('*.csv').test('sub/people.csv')).toBe(false);
  });
});
