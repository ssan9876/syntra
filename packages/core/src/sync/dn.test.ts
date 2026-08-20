import { describe, expect, it } from 'vitest';
import { normaliseDn, parentDn } from './dn.js';

describe('parentDn', () => {
  it('drops the first component', () => {
    expect(parentDn('uid=jdoe,ou=Care,dc=acme,dc=test')).toBe('ou=Care,dc=acme,dc=test');
  });

  it('keeps a value that contains an ESCAPED comma whole', () => {
    // Active Directory generates exactly this for a person displayed as
    // "Doe, Jo". Splitting on the first raw comma yields
    // `Jo,ou=Care,dc=acme,dc=test`, which resolves to nothing — and every
    // caller here reads "resolves to nothing" as "in no organizational unit".
    expect(parentDn('cn=Doe\\, Jo,ou=Care,dc=acme,dc=test')).toBe('ou=Care,dc=acme,dc=test');
  });

  it('is not fooled by an escaped backslash at the end of a value', () => {
    // `cn=share\\` — the value ends in one literal backslash, so the comma
    // after it is a real separator. A scanner that treats every backslash as
    // starting an escape swallows that comma and returns the wrong parent.
    expect(parentDn('cn=share\\\\,ou=Care,dc=acme,dc=test')).toBe('ou=Care,dc=acme,dc=test');
  });

  it('returns null for a DN with no parent', () => {
    expect(parentDn('dc=test')).toBeNull();
    expect(parentDn('')).toBeNull();
    // A trailing comma names no parent either, and an empty DN would look up
    // the directory root.
    expect(parentDn('uid=jdoe,')).toBeNull();
  });
});

describe('normaliseDn', () => {
  it('ignores case and the optional space after a comma', () => {
    expect(normaliseDn('OU=Care, DC=acme, DC=test')).toBe(normaliseDn('ou=Care,dc=acme,dc=test'));
  });

  it('keeps genuinely different DNs different', () => {
    expect(normaliseDn('ou=Care,dc=acme,dc=test')).not.toBe(
      normaliseDn('ou=Learning,dc=acme,dc=test'),
    );
  });
});
