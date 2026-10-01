import { describe, expect, it } from 'vitest';
import { BLANK, configFromForm, deletesAccounts, formFrom, validateNumbers, skipAdvice, type Target } from './target-form.js';

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
  it('round-trips custom SCIM resource paths and defaults older targets', () => {
    const form = formFrom(target({ type: 'scim2', config: { baseUrl: 'https://fmx.test/scim', userResourcePath: '/users', groupResourcePath: '/groups' } }));
    expect(configFromForm(form, {})).toMatchObject({ userResourcePath: '/users', groupResourcePath: '/groups' });
    const older = formFrom(target({ type: 'scim2', config: {} }));
    expect(older.userResourcePath).toBe('/Users');
    expect(older.groupResourcePath).toBe('/Groups');
  });
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

describe('skipAdvice', () => {
  it('reads the run time from the current reason and from the older ISO form', () => {
    const now = skipAdvice('Skipped: run from 2026-08-01 03:00 UTC is awaiting review. Apply or cancel it.');
    const old = skipAdvice('a run from 2026-08-01T03:00:00.000Z is awaiting review (blocked), so this scheduled run did not start');
    const expected = `Skipped: the run from ${new Date('2026-08-01T03:00:00Z').toLocaleString()} is waiting for review. Apply or cancel it.`;
    expect(now).toBe(expected);
    expect(old).toBe(expected);
  });

  it('falls back when no time can be read', () => {
    expect(skipAdvice('a run is awaiting review')).toBe('Skipped: a run is waiting for review. Apply or cancel it.');
  });
});

describe('Delete accounts after N days inactive', () => {
  it('reads null as an empty box and a number as itself', () => {
    expect(formFrom(target({ deleteAfterDays: null })).deleteAfterDays).toBe('');
    expect(formFrom(target({ deleteAfterDays: 30 })).deleteAfterDays).toBe('30');
    // An older API that does not send the field: never.
    expect(formFrom(target()).deleteAfterDays).toBe('');
  });

  it('starts a new target at 30 days, the server default for AD and Entra ID', () => {
    expect(BLANK.deleteAfterDays).toBe('30');
  });

  it('sends blank as null and refuses a number before the disable or the archive', () => {
    expect(validateNumbers({ ...BLANK, deleteAfterDays: '' })).toMatchObject({ values: { deleteAfterDays: null } });
    expect(validateNumbers({ ...BLANK, deleteAfterDays: '30' })).toMatchObject({ values: { deleteAfterDays: 30 } });
    expect(validateNumbers({ ...BLANK, deleteAfterDays: 'soon' })).toMatchObject({
      bad: { deleteAfterDays: 'a whole number of days, or blank for never' },
    });
    expect(validateNumbers({ ...BLANK, disableGraceDays: '14', deleteAfterDays: '7' })).toMatchObject({
      bad: { deleteAfterDays: 'at least 14, the disable grace days' },
    });
    expect(validateNumbers({ ...BLANK, archiveAfterDays: '60', deleteAfterDays: '30' })).toMatchObject({
      bad: { deleteAfterDays: 'at least 60, the archive days' },
    });
    expect(validateNumbers({ ...BLANK, archiveAfterDays: '60', deleteAfterDays: '60' })).toMatchObject({
      values: { deleteAfterDays: 60 },
    });
  });

  it('is offered only where the connector deletes', () => {
    expect(deletesAccounts('activeDirectory')).toBe(true);
    expect(deletesAccounts('entraId')).toBe(true);
    expect(deletesAccounts('scim2')).toBe(false);
    expect(deletesAccounts('httpJson')).toBe(false);
  });

  it('reads the delete threshold, defaulting to 2 from an older API', () => {
    expect(formFrom(target({ deleteAccountThresholdPercent: 5 })).deleteAccountThresholdPercent).toBe('5');
    expect(formFrom(target()).deleteAccountThresholdPercent).toBe('2');
  });
});
