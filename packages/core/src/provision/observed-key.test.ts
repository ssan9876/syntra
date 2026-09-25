import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '@syntra/connectors';
import { observedCorrelationKey } from './observed-key.js';

const record = (attributes: Record<string, string[]>): SourceRecord => ({
  anchor: 'a1',
  objectType: 'user',
  dn: 'x',
  attributes,
});

const GUID = '11111111-2222-3333-4444-555555555555';

describe('observedCorrelationKey', () => {
  it('Active Directory: sAMAccountName exactly as read, casing kept', () => {
    expect(
      observedCorrelationKey('activeDirectory', {}, record({ sAMAccountName: ['Anna.Novak'] })),
    ).toBe('Anna.Novak');
    expect(observedCorrelationKey('activeDirectory', {}, record({}))).toBe('');
  });

  it('SCIM: userName', () => {
    expect(observedCorrelationKey('scim2', {}, record({ userName: ['anna.novak'] }))).toBe(
      'anna.novak',
    );
  });

  it('httpJson: the Syntra attribute the document maps correlationAt to', () => {
    const config = {
      document: { account: { correlationAt: 'login', fields: { login: 'uid' } } },
    };
    expect(
      observedCorrelationKey('httpJson', config, record({ uid: ['anna.novak'], userName: ['no'] })),
    ).toBe('anna.novak');
  });

  describe('Entra ID', () => {
    const config = { tenantId: GUID, userPrincipalDomain: 'contoso.com' };
    const upn = (value: string) => record({ userPrincipalName: [value] });

    it('the local part of a UPN in the configured domain', () => {
      expect(observedCorrelationKey('entraId', config, upn('anna.novak@contoso.com'))).toBe(
        'anna.novak',
      );
    });

    it('the domain is compared case-insensitively', () => {
      expect(observedCorrelationKey('entraId', config, upn('Anna.Novak@Contoso.COM'))).toBe(
        'Anna.Novak',
      );
    });

    it('a UPN in another domain stays whole, so it can never equal a key', () => {
      expect(observedCorrelationKey('entraId', config, upn('anna.novak@partner.example'))).toBe(
        'anna.novak@partner.example',
      );
    });

    it('falls back to tenantId when that is a domain and no userPrincipalDomain is set', () => {
      expect(
        observedCorrelationKey('entraId', { tenantId: 'contoso.com' }, upn('anna.novak@contoso.com')),
      ).toBe('anna.novak');
    });

    it('with no domain to complete a key with, nothing is in-domain', () => {
      expect(
        observedCorrelationKey('entraId', { tenantId: GUID }, upn('anna.novak@contoso.com')),
      ).toBe('anna.novak@contoso.com');
    });

    it('a value with no domain (the connector fell back to the object id) is no key', () => {
      expect(observedCorrelationKey('entraId', config, upn('a1'))).toBe('');
      expect(observedCorrelationKey('entraId', config, record({}))).toBe('');
    });
  });
});
