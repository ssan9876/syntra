import { describe, expect, it } from 'vitest';
import { BLANK, configFromForm, formFrom, validateNumbers, type Target } from './target-form.js';

const target = (overrides: Partial<Target> = {}): Target => ({
  id: 't1',
  name: 'Entra',
  type: 'entraId',
  config: {},
  enabled: true,
  autoApply: false,
  schedule: null,
  enforcementMode: 'additive',
  preHireDays: 0,
  entitlementRevocationDelayDays: 0,
  disableGraceDays: 0,
  archiveAfterDays: null,
  reenableWithoutConfirmationDays: 7,
  renameEnabled: false,
  createAccountThresholdPercent: 20,
  disableAccountThresholdPercent: 10,
  archiveAccountThresholdPercent: 2,
  revokeEntitlementThresholdPercent: 10,
  deactivateSyntraUserThresholdPercent: 10,
  perEntitlementThresholdPercent: 50,
  personPopulationDropPercent: 20,
  maxAttempts: 3,
  consecutiveSkippedRuns: 0,
  lastSkipReason: null,
  externalWritesPausedAt: null,
  externalWritesPausedByUserId: null,
  externalWritesPauseReason: null,
  externalWritesPauseExpiresAt: null,
  externalWritesResumedAt: null,
  externalWritesResumedByUserId: null,
  maintenanceWindowEnabled: false,
  maintenanceWindowDays: [],
  maintenanceWindowStartMinute: null,
  maintenanceWindowDurationMinutes: null,
  ...overrides,
});

describe('bounded connector retries', () => {
  it('round-trips the saved attempt limit and refuses values outside 1–10', () => {
    expect(formFrom(target({ maxAttempts: 6 })).maxAttempts).toBe('6');
    expect(validateNumbers({ ...BLANK, maxAttempts: '0' })).toMatchObject({ bad: { maxAttempts: expect.any(String) } });
    expect(validateNumbers({ ...BLANK, maxAttempts: '10' })).toMatchObject({ values: { maxAttempts: 10 } });
  });
});

describe('the native Entra ID target form', () => {
  it('reads the tenant, client id and correlation field from a saved target', () => {
    const form = formFrom(
      target({
        config: {
          tenantId: 'contoso.onmicrosoft.com',
          clientId: 'client-1',
          correlationField: 'extensionAttribute2',
          managedAttributes: ['displayName'],
        },
      }),
    );
    expect(form.type).toBe('entraId');
    expect(form.entraTenantId).toBe('contoso.onmicrosoft.com');
    expect(form.entraClientId).toBe('client-1');
    expect(form.entraCorrelationField).toBe('extensionAttribute2');
    // Never populated from a saved target: the vault holds it.
    expect(form.bindPassword).toBe('');
  });

  it('defaults the correlation field to employeeId', () => {
    expect(BLANK.entraCorrelationField).toBe('employeeId');
    expect(formFrom(target({ config: { tenantId: 't', clientId: 'c' } })).entraCorrelationField).toBe(
      'employeeId',
    );
  });

  it('builds the entraId config and carries the keys it does not own through', () => {
    const config = configFromForm(
      {
        ...BLANK,
        type: 'entraId',
        entraTenantId: ' contoso.onmicrosoft.com ',
        entraClientId: 'client-1 ',
        entraCorrelationField: 'extensionAttribute1',
      },
      { managedAttributes: ['displayName'], groupScope: { includeMailEnabled: true } },
    );
    expect(config).toEqual({
      tenantId: 'contoso.onmicrosoft.com',
      clientId: 'client-1',
      correlationField: 'extensionAttribute1',
      managedAttributes: ['displayName'],
      groupScope: { includeMailEnabled: true },
    });
  });

  it('reads and writes the user principal name domain, and sends nothing when blank', () => {
    const form = formFrom(
      target({
        config: { tenantId: '99999999-8888-7777-6666-555555555555', clientId: 'c', userPrincipalDomain: 'contoso.com' },
      }),
    );
    expect(form.entraUserPrincipalDomain).toBe('contoso.com');
    expect(
      configFromForm({ ...BLANK, type: 'entraId', entraTenantId: 't', entraClientId: 'c', entraUserPrincipalDomain: ' Contoso.COM ' }, {}),
    ).toMatchObject({ userPrincipalDomain: 'contoso.com' });
    // Cleared: absent, not '' (which the server refuses), and not carried
    // through from the saved config either -- the form owns the key.
    const cleared = configFromForm({ ...BLANK, type: 'entraId', entraTenantId: 't', entraClientId: 'c' }, {});
    expect(cleared).not.toHaveProperty('userPrincipalDomain');
  });

  it('still reads the document-driven Entra target from its OAuth block', () => {
    const form = formFrom(
      target({
        type: 'httpJson',
        config: {
          document: {
            name: 'Microsoft Entra ID',
            auth: {
              type: 'oauth2',
              tokenUrl: 'https://login.microsoftonline.com/tenant-9/oauth2/v2.0/token',
              clientId: 'client-9',
            },
          },
        },
      }),
    );
    expect(form.type).toBe('httpJson');
    expect(form.entraTenantId).toBe('tenant-9');
    expect(form.entraClientId).toBe('client-9');
  });
});
