import { describe, expect, it } from 'vitest';
import { resolveAcsUrl, type SamlConfigRecord } from './saml-config-service.js';

const baseConfig = (overrides: Partial<SamlConfigRecord> = {}): SamlConfigRecord => ({
  id: 'cfg-1',
  applicationId: 'app-1',
  spEntityId: 'https://sp.example.test/metadata',
  acsUrls: ['https://sp.example.test/acs', 'https://sp.example.test/acs2'],
  defaultAcsUrl: 'https://sp.example.test/acs',
  acsBinding: 'HTTP-POST',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  nameIdClaim: null,
  spCertificates: [],
  wantAuthnRequestsSigned: false,
  encryptAssertions: false,
  encryptionCertificate: null,
  sloUrl: null,
  sloBinding: 'HTTP-POST',
  allowIdpInitiated: false,
  assertionLifetimeMs: 300_000,
  ...overrides,
});

describe('resolveAcsUrl', () => {
  it('accepts a requested URL that exactly matches an allowlist entry', () => {
    const config = baseConfig();
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs2')).toBe(
      'https://sp.example.test/acs2',
    );
  });

  it('falls back to the recorded default when nothing was requested', () => {
    const config = baseConfig();
    expect(resolveAcsUrl(config, null)).toBe('https://sp.example.test/acs');
    expect(resolveAcsUrl(config, '')).toBe('https://sp.example.test/acs');
  });

  it('resolves to null, never to acsUrls[0], when there is no default and nothing was requested', () => {
    // This is the exact fallback the plan revision removed: a config with no
    // default must refuse rather than silently pick the first allowlist
    // entry, because metadata re-import can reorder that list with no write
    // and no audit event.
    const config = baseConfig({ defaultAcsUrl: null });
    expect(resolveAcsUrl(config, null)).toBeNull();
  });

  it('resolves to null when the recorded default is not itself on the allowlist', () => {
    // Defensive: a corrupted or hand-edited row must not be trusted just
    // because a defaultAcsUrl column is populated.
    const config = baseConfig({ defaultAcsUrl: 'https://sp.example.test/stale' });
    expect(resolveAcsUrl(config, null)).toBeNull();
  });

  it('refuses a requested URL that is a prefix of a registered one', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs/callback'] });
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs')).toBeNull();
  });

  it('refuses a requested URL that extends a registered one', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs/evil')).toBeNull();
    expect(resolveAcsUrl(config, 'https://sp.example.test/acsX')).toBeNull();
  });

  it('refuses a requested URL that differs only in scheme', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'http://sp.example.test/acs')).toBeNull();
  });

  it('refuses a requested URL that differs only in host case', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'https://SP.example.test/acs')).toBeNull();
  });

  it('refuses a requested URL that differs only by a trailing slash', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs/')).toBeNull();
  });

  it('refuses a requested URL for a different service provider entirely', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'https://attacker.test/acs')).toBeNull();
  });

  it('refuses everything when the allowlist is empty', () => {
    const config = baseConfig({ acsUrls: [], defaultAcsUrl: null });
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs')).toBeNull();
    expect(resolveAcsUrl(config, null)).toBeNull();
  });
});
