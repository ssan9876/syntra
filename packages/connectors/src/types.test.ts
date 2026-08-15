import { describe, expect, it } from 'vitest';
import { first, type SourceRecord } from './types.js';

const record: SourceRecord = {
  anchor: 'a1',
  objectType: 'user',
  dn: 'cn=Jo,ou=Care,dc=acme,dc=test',
  attributes: {
    cn: ['Jo Doe'],
    mail: ['jo@acme.test'],
    memberOf: ['cn=Nurses,dc=acme,dc=test', 'cn=Staff,dc=acme,dc=test'],
    empty: [],
  },
};

describe('first', () => {
  it('returns the first value of a multi-valued attribute', () => {
    // LDAP attributes are always multi-valued on the wire, even when the
    // schema says otherwise, so callers must not index blindly.
    expect(first(record, 'memberOf')).toBe('cn=Nurses,dc=acme,dc=test');
  });

  it('returns a single value', () => {
    expect(first(record, 'mail')).toBe('jo@acme.test');
  });

  it('returns undefined for an attribute that is present but empty', () => {
    expect(first(record, 'empty')).toBeUndefined();
  });

  it('returns undefined for an absent attribute', () => {
    expect(first(record, 'telephoneNumber')).toBeUndefined();
  });

  it('is case-insensitive, because LDAP attribute names are', () => {
    expect(first(record, 'MAIL')).toBe('jo@acme.test');
  });
});
