import { describe, expect, it } from 'vitest';
import { isProtocolEndpoint, matchesAllowlist } from '@syntra/contracts';
import {
  assertProtocolHost,
  tenantProtocolIdentity,
} from './protocol-identity.js';
import { ProblemError } from '../plugins/problem-json.js';

const asRequest = (host: string) =>
  ({ headers: { host } } as Parameters<typeof assertProtocolHost>[0]);

describe('tenantProtocolIdentity', () => {
  it('derives every identifier from the tenant primary domain', () => {
    const id = tenantProtocolIdentity(
      { primaryDomain: 'sso.acme.test' },
      'https://syntra.example:8443',
    );
    expect(id.base).toBe('https://sso.acme.test:8443');
    expect(id.issuer).toBe('https://sso.acme.test:8443/oidc');
    expect(id.entityId).toBe('https://sso.acme.test:8443/saml/idp');
    expect(id.ssoUrl).toBe('https://sso.acme.test:8443/saml/sso');
    expect(id.sloUrl).toBe('https://sso.acme.test:8443/saml/slo');
  });

  it('falls back to PUBLIC_URL when the tenant has no primary domain', () => {
    const id = tenantProtocolIdentity({ primaryDomain: null }, 'https://syntra.example');
    expect(id.base).toBe('https://syntra.example');
    expect(id.issuer).toBe('https://syntra.example/oidc');
  });

  it('never reads the Host header — the same tenant yields the same issuer whatever the request claims', () => {
    const tenant = { primaryDomain: 'sso.acme.test' };
    const a = tenantProtocolIdentity(tenant, 'https://syntra.example');
    const b = tenantProtocolIdentity(tenant, 'https://syntra.example');
    expect(a.issuer).toBe(b.issuer);
    // The signature takes no request at all, which is what makes the
    // vulnerability unrepresentable rather than merely avoided.
    expect(tenantProtocolIdentity.length).toBe(2);
  });
});

describe('assertProtocolHost', () => {
  const id = tenantProtocolIdentity({ primaryDomain: 'sso.acme.test' }, 'https://syntra.example');

  it('accepts a request that arrived on the tenant own host', () => {
    expect(() => assertProtocolHost(asRequest('sso.acme.test'), id)).not.toThrow();
    expect(() => assertProtocolHost(asRequest('SSO.ACME.TEST:443'), id)).not.toThrow();
  });

  it('refuses the sibling-label attack that tenant resolution admits', () => {
    // tenant-context.ts resolves a tenant from the leftmost label, so this
    // host resolves tenant "sso" — and without this check an assertion would
    // be minted naming an issuer the attacker chose.
    expect(() => assertProtocolHost(asRequest('sso.acme.test.attacker.example'), id))
      .toThrow(ProblemError);
  });

  it('refuses a bare missing Host', () => {
    expect(() => assertProtocolHost(asRequest(''), id)).toThrow(ProblemError);
  });
});

describe('isProtocolEndpoint', () => {
  it('accepts https and http', () => {
    expect(isProtocolEndpoint('https://sp.example.test/acs')).toBe(true);
    expect(isProtocolEndpoint('http://localhost:3000/callback')).toBe(true);
  });

  it('refuses javascript, data and file URIs that z.string().url() accepts', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(isProtocolEndpoint(bad)).toBe(false);
    }
  });

  it('refuses a URI carrying a fragment, which RFC 6749 forbids on a redirect_uri', () => {
    expect(isProtocolEndpoint('https://sp.example.test/cb#frag')).toBe(false);
  });
});

describe('matchesAllowlist', () => {
  const allow = ['https://sp.example.test/acs', 'https://sp.example.test/acs2'];

  it('accepts an exact match', () => {
    expect(matchesAllowlist('https://sp.example.test/acs', allow)).toBe(true);
  });

  it('refuses a prefix, a suffix, a case change and a trailing slash', () => {
    for (const bad of [
      'https://sp.example.test/acs/../../evil',
      'https://sp.example.test/acs/',
      'https://sp.example.test/acsX',
      'https://sp.example.test/ACS',
      'https://sp.example.test',
      'https://evil.test/acs',
    ]) {
      expect(matchesAllowlist(bad, allow)).toBe(false);
    }
  });

  it('refuses everything when the allowlist is empty', () => {
    expect(matchesAllowlist('https://sp.example.test/acs', [])).toBe(false);
  });
});
