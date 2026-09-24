import { describe, expect, it } from 'vitest';
import { capabilitiesForTarget, targetConnectorCapabilities } from './capabilities.js';
import { entraIdDocument } from './http/documents/entra-id.js';

describe('target connector capabilities', () => {
  it('labels current and planned connector support without claiming unavailable integrations', () => {
    expect(targetConnectorCapabilities('activeDirectory')).toMatchObject({ readBack: true, createAccount: true, disableAccount: true });
    expect(targetConnectorCapabilities('scim2')).toMatchObject({ readBack: true, createAccount: true, manageEntitlements: true });
    expect(targetConnectorCapabilities('entraId')).toMatchObject({ available: true, readBack: true, manageEntitlements: true });
    expect(targetConnectorCapabilities('microsoft365')).toMatchObject({ available: false, readBack: false });
    expect(targetConnectorCapabilities('okta')).toMatchObject({ available: false });
  });

  it('derives the capabilities of an httpJson target from what its document declares', () => {
    // The shipped Entra document: create, update, disable, grant, revoke and
    // a members read -- everything.
    expect(capabilitiesForTarget('httpJson', { document: entraIdDocument })).toEqual({
      available: true,
      readBack: true,
      createAccount: true,
      updateAccount: true,
      disableAccount: true,
      manageEntitlements: true,
    });
    // A read-only document promises nothing it cannot do.
    expect(
      capabilitiesForTarget('httpJson', {
        document: { account: { list: { path: '/users' }, anchorAt: 'id' } },
      }),
    ).toEqual({
      available: true,
      readBack: false,
      createAccount: false,
      updateAccount: false,
      disableAccount: false,
      manageEntitlements: false,
    });
    // No document at all is not a capable target.
    expect(capabilitiesForTarget('httpJson', {})).toMatchObject({ available: true, createAccount: false, readBack: false });
  });

  it('does not advertise HTTP account creation without correlation and provenance read-back', () => {
    const unsafe = {
      ...entraIdDocument,
      account: { ...entraIdDocument.account, provenance: undefined },
    };
    expect(capabilitiesForTarget('httpJson', { document: unsafe }).createAccount).toBe(false);
  });

  it('is static for every hand-written connector', () => {
    expect(capabilitiesForTarget('entraId', { tenantId: 'x' })).toEqual(targetConnectorCapabilities('entraId'));
    expect(capabilitiesForTarget('activeDirectory', {})).toEqual(targetConnectorCapabilities('activeDirectory'));
  });
});
