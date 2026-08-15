import { describe, expect, it } from 'vitest';
import { ldapConfigSchema } from './config.js';

const base = {
  url: 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
};

describe('ldapConfigSchema tlsMode', () => {
  it('leaves an ldap:// source plain when the mode is not given', () => {
    // What the connector did before the mode existed, kept deliberately: a
    // source saved without this field must not change transport on upgrade.
    expect(ldapConfigSchema.parse(base).tlsMode).toBe('plain');
  });

  it('reads an ldaps:// source as ldaps when the mode is not given', () => {
    expect(
      ldapConfigSchema.parse({ ...base, url: 'ldaps://dc.acme.test:636' })
        .tlsMode,
    ).toBe('ldaps');
  });

  it('accepts starttls on an ldap:// URL, which has no scheme of its own', () => {
    expect(
      ldapConfigSchema.parse({ ...base, tlsMode: 'starttls' }).tlsMode,
    ).toBe('starttls');
  });

  it('refuses a plaintext mode on an ldaps:// URL rather than picking one', () => {
    // Honouring the mode would point a plaintext client at a TLS port;
    // honouring the scheme would ignore what an administrator chose. Both
    // readings are wrong, so the contradiction is reported.
    const result = ldapConfigSchema.safeParse({
      ...base,
      url: 'ldaps://dc.acme.test:636',
      tlsMode: 'plain',
    });
    expect(result.success).toBe(false);
  });

  it('refuses starttls on an ldaps:// URL', () => {
    expect(
      ldapConfigSchema.safeParse({
        ...base,
        url: 'ldaps://dc.acme.test:636',
        tlsMode: 'starttls',
      }).success,
    ).toBe(false);
  });

  it('refuses ldaps mode without an ldaps:// URL', () => {
    expect(
      ldapConfigSchema.safeParse({ ...base, tlsMode: 'ldaps' }).success,
    ).toBe(false);
  });

  it('refuses a mode it has never heard of', () => {
    expect(
      ldapConfigSchema.safeParse({ ...base, tlsMode: 'ssl' }).success,
    ).toBe(false);
  });

  it('verifies the server certificate unless a source says otherwise', () => {
    expect(ldapConfigSchema.parse(base).rejectUnauthorized).toBe(true);
    expect(
      ldapConfigSchema.parse({ ...base, rejectUnauthorized: false })
        .rejectUnauthorized,
    ).toBe(false);
  });
});
