import { describe, expect, it } from 'vitest';
import {
  EmailDomainNotVerifiedError,
  addressedDomain,
  assertTargetDomainsVerified,
  domainIsCovered,
  emailDomainOf,
  entraUpnDomain,
  isAddressAttribute,
  lookupEmailDomainVerification,
  normalizeEmailDomain,
  unverifiedTemplateDomains,
  verificationRecord,
} from './email-domains.js';

describe('normalizeEmailDomain', () => {
  it('lowercases and drops a trailing dot', () => {
    expect(normalizeEmailDomain(' Contoso.COM. ')).toBe('contoso.com');
  });

  it('turns an internationalised name into punycode', () => {
    expect(normalizeEmailDomain('bücher.example')).toBe('xn--bcher-kva.example');
  });

  it.each(['contoso', '10.0.0.1', 'a@b.com', 'https://contoso.com', '-bad.com', 'bad-.com', 'a..com', '', 'con toso.com'])(
    'refuses %j',
    (input) => {
      expect(normalizeEmailDomain(input)).toBeNull();
    },
  );
});

describe('domainIsCovered', () => {
  const verified = ['contoso.com'];

  it('covers the domain itself and its subdomains', () => {
    expect(domainIsCovered('contoso.com', verified)).toBe(true);
    expect(domainIsCovered('EU.Contoso.com', verified)).toBe(true);
  });

  it('does not cover a domain that merely ends in the same letters', () => {
    expect(domainIsCovered('notcontoso.com', verified)).toBe(false);
    expect(domainIsCovered('contoso.com.evil.example', verified)).toBe(false);
  });

  it('covers nothing when nothing is verified', () => {
    expect(domainIsCovered('contoso.com', [])).toBe(false);
  });
});

describe('addresses', () => {
  it('reads the domain after the last @', () => {
    expect(emailDomainOf('Jane_Doe@DeezNutz.org')).toBe('deeznutz.org');
    expect(emailDomainOf('no-at-sign')).toBeNull();
  });

  it('reads through an smtp: proxy-address prefix, and ignores a value with no @', () => {
    expect(addressedDomain('SMTP:anna@contoso.com')).toBe('contoso.com');
    expect(addressedDomain('anna.novak')).toBeNull();
  });

  it('knows which attributes hold addresses', () => {
    for (const name of ['mail', 'email', 'emails', 'otherMails', 'userPrincipalName', 'proxyAddresses', 'upn']) {
      expect(isAddressAttribute(name), name).toBe(true);
    }
    for (const name of ['mailNickname', 'displayName', 'description', 'department']) {
      expect(isAddressAttribute(name), name).toBe(false);
    }
  });
});

describe('unverifiedTemplateDomains', () => {
  it('finds a literal domain no verified domain covers', () => {
    expect(unverifiedTemplateDomains('%person.givenName%.%person.familyName%@elsewhere.example', ['contoso.com'])).toEqual([
      'elsewhere.example',
    ]);
  });

  it('passes a verified literal domain and a subdomain of one', () => {
    expect(unverifiedTemplateDomains('%person.givenName%@eu.contoso.com', ['contoso.com'])).toEqual([]);
  });

  it('leaves a domain built from a placeholder to the render-time check', () => {
    expect(unverifiedTemplateDomains('%person.businessEmail%', [])).toEqual([]);
    expect(unverifiedTemplateDomains('%person.givenName%@%contract.employer%.com', [])).toEqual([]);
  });
});

describe('lookupEmailDomainVerification', () => {
  const record = verificationRecord('tok');

  it('verifies when the exact record is published', async () => {
    const outcome = await lookupEmailDomainVerification('contoso.com', record, async () => ['v=spf1 -all', record]);
    expect(outcome).toEqual({ verified: true });
  });

  it('says so when another tenant or an old token is published instead', async () => {
    const outcome = await lookupEmailDomainVerification('contoso.com', record, async () => [verificationRecord('other')]);
    expect(outcome).toEqual({ verified: false, reason: expect.stringContaining('but not this one') });
  });

  it('reports a domain with no TXT records in words', async () => {
    const outcome = await lookupEmailDomainVerification('contoso.com', record, async () => {
      throw Object.assign(new Error('nope'), { code: 'ENODATA' });
    });
    expect(outcome).toEqual({ verified: false, reason: 'contoso.com has no TXT records yet.' });
  });
});

describe('Entra ID userPrincipalName domain', () => {
  it('is userPrincipalDomain, else a tenantId that is a domain', () => {
    expect(entraUpnDomain({ tenantId: '785f0bd2-881f-42c2-acd8-7235d958f7e0', userPrincipalDomain: 'ssander.xyz' })).toBe('ssander.xyz');
    expect(entraUpnDomain({ tenantId: 'contoso.onmicrosoft.com' })).toBe('contoso.onmicrosoft.com');
    expect(entraUpnDomain({ tenantId: '785f0bd2-881f-42c2-acd8-7235d958f7e0' })).toBeNull();
  });

  it('refuses a target whose domain is not verified, naming the field', () => {
    expect(() =>
      assertTargetDomainsVerified('entraId', { tenantId: '785f0bd2-881f-42c2-acd8-7235d958f7e0', userPrincipalDomain: 'ssander.xyz' }, []),
    ).toThrow(EmailDomainNotVerifiedError);
    try {
      assertTargetDomainsVerified('entraId', { tenantId: 'contoso.onmicrosoft.com' }, []);
    } catch (cause) {
      expect((cause as EmailDomainNotVerifiedError).field).toBe('config.tenantId');
    }
  });

  it('passes a verified domain, and ignores targets that take their domain from the profile', () => {
    expect(() =>
      assertTargetDomainsVerified('entraId', { tenantId: 'x', userPrincipalDomain: 'ssander.xyz' }, ['ssander.xyz']),
    ).not.toThrow();
    expect(() => assertTargetDomainsVerified('activeDirectory', {}, [])).not.toThrow();
  });
});
