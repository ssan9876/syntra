import { describe, expect, it } from 'vitest';
import { FakeTarget } from './fake-target.js';
import { certifyTargetConnector } from './target-connector-certification.js';

describe('target connector certification runner', () => {
  it('certifies the shared lifecycle and observed-state contract', async () => {
    const connector = new FakeTarget();
    connector.containers.push('OU=Users,DC=acme,DC=test');
    connector.entitlements.push({
      externalId: 'group-1',
      dn: 'CN=Staff,OU=Groups,DC=acme,DC=test',
      type: 'group',
      displayName: 'Staff',
    });

    const report = await certifyTargetConnector({
      name: 'fake target',
      connector,
      config: { domain: 'acme.test' },
      create: {
        op: 'create_account',
        actionId: 'cert-create-1',
        correlationKey: 'cert.user',
        attributes: { displayName: ['Certification User'] },
        enabled: true,
        initialPassword: 'not-retained',
      },
      update: (anchor) => ({
        op: 'update_account',
        actionId: 'cert-update-1',
        anchor,
        attributes: { displayName: ['Updated Certification User'] },
      }),
      disable: (anchor) => ({
        op: 'disable_account',
        actionId: 'cert-disable-1',
        anchor,
        reason: 'certification',
      }),
      entitlement: {
        id: 'group-1',
        grant: (anchor) => ({
          op: 'grant_entitlement',
          actionId: 'cert-grant-1',
          anchor,
          entitlementId: 'group-1',
        }),
        revoke: (anchor) => ({
          op: 'revoke_entitlement',
          actionId: 'cert-revoke-1',
          anchor,
          entitlementId: 'group-1',
        }),
      },
      missingAnchor: 'does-not-exist',
      assertCreated: (observed) => {
        expect(observed.account?.attributes.displayName).toEqual(['Certification User']);
      },
      assertUpdated: (observed) => {
        expect(observed.account?.attributes.displayName).toEqual(['Updated Certification User']);
      },
    });

    expect(report.checks).toEqual([
      'connection',
      'container-placement',
      'create',
      'idempotent-create',
      'create-read-back',
      'update',
      'idempotent-update',
      'update-read-back',
      'grant-read-back',
      'revoke-read-back',
      'disable',
      'idempotent-disable',
      'disable-read-back',
      'missing-object',
    ]);
  });

  it('fails when a connector claims success without an anchor', async () => {
    const connector = new FakeTarget();
    connector.containers.push('OU=Users,DC=acme,DC=test');
    connector.write = async () => ({ ok: true, message: 'claimed success' });

    await expect(
      certifyTargetConnector({
        name: 'broken target',
        connector,
        config: { domain: 'acme.test' },
        create: {
          op: 'create_account',
          actionId: 'broken-create',
          correlationKey: 'broken.user',
          attributes: {},
          enabled: true,
          initialPassword: 'not-retained',
        },
        missingAnchor: 'missing',
      }),
    ).rejects.toThrow(/without returning an anchor/);
  });

  it('fails a connector that places accounts in containers but lists none', async () => {
    // What every flat target looked like to a run before placement was
    // declared: every person dropped as `container_missing`, forever.
    const connector = new FakeTarget();

    await expect(
      certifyTargetConnector({
        name: 'containerless target',
        connector,
        config: { domain: 'acme.test' },
        create: {
          op: 'create_account',
          actionId: 'containerless-create',
          correlationKey: 'flat.user',
          attributes: {},
          enabled: true,
          initialPassword: 'not-retained',
        },
        missingAnchor: 'missing',
      }),
    ).rejects.toThrow(/places accounts in containers but listed none/);
  });

  it('certifies a flat target that declares it places accounts nowhere', async () => {
    const connector = new FakeTarget();
    connector.placesInContainers = false;

    const report = await certifyTargetConnector({
      name: 'flat target',
      connector,
      config: { domain: 'acme.test' },
      create: {
        op: 'create_account',
        actionId: 'flat-create',
        correlationKey: 'flat.user',
        attributes: {},
        enabled: true,
        initialPassword: 'not-retained',
      },
      missingAnchor: 'missing',
    });
    expect(report.checks).toContain('container-placement');
  });
});
