import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorError, createConnectorServer, describeConnector } from '@syntra/connector-sdk';
import { createInMemoryConnector } from '@syntra/connector-sdk/example';
import { certifyTargetConnector } from '../testing/target-connector-certification.js';
import { capabilitiesForTarget } from '../capabilities.js';
import { correlationKeyPolicyFor } from '../naming.js';
import { isRetryable, observedEnabled } from '../types.js';
import { targetConfigSchemaFor, targetConnectorFor } from '../registry.js';
import { remoteTargetConnector } from './connector.js';
import { remoteTargetConfigSchema } from './config.js';

const SECRET = 'remote-target-shared-secret-0123456789';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function service(options: Parameters<typeof createInMemoryConnector>[0] = {}) {
  const { connector, store } = createInMemoryConnector({
    entitlements: [{ id: 'g-staff', type: 'group', displayName: 'Staff' }],
    ...options,
  });
  const server = createConnectorServer({ connector, secrets: SECRET, onError: () => {} });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // `bindPassword` is the name core hands every target's vault credential under.
  const config = { baseUrl, bindPassword: SECRET, allowPrivateAddresses: true, pageSize: 2, timeoutMs: 2000 };
  return { connector, store, config };
}

const create = {
  op: 'create_account' as const,
  actionId: 'cert-remote-create',
  correlationKey: 'connector.certification',
  attributes: { displayName: ['Connector Certification'], title: ['Tester'] },
  enabled: true,
  initialPassword: 'Initial-Passw0rd!',
};

describe('remote target: shared certification', () => {
  it('passes the lifecycle contract every built-in adapter passes, against the SDK example', async () => {
    const { config } = await service();
    const report = await certifyTargetConnector({
      name: 'Connector service',
      connector: remoteTargetConnector,
      config,
      create,
      update: (anchor) => ({ op: 'update_account', actionId: 'cert-remote-update', anchor, attributes: { title: ['Verified Tester'] } }),
      disable: (anchor) => ({ op: 'disable_account', actionId: 'cert-remote-disable', anchor, reason: 'certification' }),
      entitlement: {
        id: 'g-staff',
        grant: (anchor) => ({ op: 'grant_entitlement', actionId: 'cert-remote-grant', anchor, entitlementId: 'g-staff' }),
        revoke: (anchor) => ({ op: 'revoke_entitlement', actionId: 'cert-remote-revoke', anchor, entitlementId: 'g-staff' }),
      },
      missingAnchor: 'missing-remote-account',
      assertCreated: (observed) => {
        expect(observed.account?.attributes.correlationKey).toEqual(['connector.certification']);
        expect(observed.account?.attributes.displayName).toEqual(['Connector Certification']);
      },
      assertUpdated: (observed) => expect(observed.account?.attributes.title).toEqual(['Verified Tester']),
    });
    expect(report.checks).toContain('idempotent-create');
    expect(report.checks).toContain('revoke-read-back');
    expect(report.checks).toContain('missing-object');
  });

  it('certifies a service with containers when the target says so', async () => {
    const { config } = await service({ containers: ['ou=staff'] });
    const report = await certifyTargetConnector({
      name: 'Connector service with containers',
      connector: remoteTargetConnector,
      config: { ...config, placesAccountsInContainers: true },
      create,
      missingAnchor: 'missing',
    });
    expect(report.checks).toContain('container-placement');
  });
});

describe('remote target: connection test', () => {
  it('names the service and its version', async () => {
    const { config } = await service();
    expect(await remoteTargetConnector.test(config)).toEqual({
      ok: true,
      message: 'Connected to "In-memory example" 1.0.0. 0 accounts.',
    });
  });

  it('says the shared secret is wrong when the service refuses the signature', async () => {
    const { config } = await service();
    const result = await remoteTargetConnector.test({ ...config, bindPassword: `${SECRET}-old` });
    expect(result).toEqual({
      ok: false,
      message:
        "Connector service refused Syntra's signature on describe (HTTP 401): Request signature does not match. Check the shared secret.",
    });
  });

  it('refuses a service that speaks another protocol version', async () => {
    const { connector, config } = await service();
    const { createServer } = await import('node:http');
    const future = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...describeConnector(connector), protocolVersions: [2] }));
    });
    servers.push(future);
    await new Promise<void>((resolve) => future.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(future.address() as AddressInfo).port}`;
    expect(await remoteTargetConnector.test({ ...config, baseUrl })).toEqual({
      ok: false,
      message:
        'Connector service "In-memory example" speaks protocol 2. Syntra speaks 1. Update the connector service or Syntra.',
    });
  });

  it('refuses a target whose container setting disagrees with the service', async () => {
    const { config } = await service({ containers: ['ou=staff'] });
    expect(await remoteTargetConnector.test(config)).toEqual({
      ok: false,
      message:
        'Connector service "In-memory example" places accounts in containers. Turn on placesAccountsInContainers.',
    });
  });

  it('refuses a private address unless the target allows it', async () => {
    const { config } = await service();
    const result = await remoteTargetConnector.test({ ...config, allowPrivateAddresses: false });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('127.0.0.1');
  });
});

describe('remote target: writes', () => {
  it('reports a timed-out write as transient, and its retry adopts the account', async () => {
    const { config, store } = await service();
    store.delayMs = 1500;
    const first = await remoteTargetConnector.write({ ...config, timeoutMs: 1000 }, create);
    expect(first).toMatchObject({ ok: false, failure: 'transient' });
    expect(isRetryable(first.failure)).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    store.delayMs = 0;
    const retried = await remoteTargetConnector.write(config, create);
    expect(retried).toMatchObject({ ok: true, anchor: [...store.accounts.keys()][0] });
  });

  it('keeps the service classification: conflict and rejected are not retried, throttled is', async () => {
    const { config, store } = await service();
    store.failNext('create_account', new ConnectorError('conflict', 'Account connector.certification exists.'));
    const conflict = await remoteTargetConnector.write(config, create);
    expect(conflict).toEqual({ ok: false, failure: 'conflict', message: 'Account connector.certification exists.' });
    expect(isRetryable(conflict.failure)).toBe(false);

    store.failNext('create_account', new ConnectorError('throttled', 'Slow down.', { retryAfterMs: 2000 }));
    const throttled = await remoteTargetConnector.write(config, create);
    expect(throttled).toEqual({ ok: false, failure: 'throttled', message: 'Slow down.', retryAfterMs: 2000 });
    expect(isRetryable(throttled.failure)).toBe(true);
  });

  it('refuses a write with no shared secret before any request', async () => {
    const { config } = await service();
    const { bindPassword: _omitted, ...noSecret } = config;
    expect(await remoteTargetConnector.write(noSecret, create)).toEqual({
      ok: false,
      failure: 'rejected',
      message: 'No shared secret is set.',
    });
  });
});

describe('remote target: reads', () => {
  it('pages through accounts and reports login and enabled state where Syntra reads them', async () => {
    const { config, store } = await service();
    for (const name of ['a', 'b', 'c']) {
      store.accounts.set(name, { anchor: name, correlationKey: `${name}.user`, attributes: {}, enabled: name !== 'b', createdBy: 'x' });
    }
    const records = [];
    for await (const record of remoteTargetConnector.read(config)) records.push(record);
    expect(records.map((r) => r.attributes.correlationKey?.[0])).toEqual(['a.user', 'b.user', 'c.user']);
    expect(records.map(observedEnabled)).toEqual([true, false, true]);
  });

  it('lists entitlements with their id as the dn', async () => {
    const { config } = await service();
    const listed = [];
    for await (const entitlement of remoteTargetConnector.listEntitlements(config)) listed.push(entitlement);
    expect(listed).toEqual([{ externalId: 'g-staff', dn: 'g-staff', type: 'group', displayName: 'Staff' }]);
  });
});

describe('remote target: registry and policy', () => {
  it('is registered with its config schema', () => {
    expect(targetConfigSchemaFor('remote')).toBe(remoteTargetConfigSchema);
    expect(typeof targetConnectorFor('remote').write).toBe('function');
  });

  it('declares placement from its config, with no I/O', () => {
    expect(remoteTargetConnector.placesAccountsInContainers({ baseUrl: 'https://x' })).toBe(false);
    expect(remoteTargetConnector.placesAccountsInContainers({ baseUrl: 'https://x', placesAccountsInContainers: true })).toBe(true);
  });

  it('does not advertise delete', () => {
    expect(capabilitiesForTarget('remote', {}).deleteAccount).toBe(false);
  });

  it('reads its naming policy from the target config', () => {
    expect(correlationKeyPolicyFor('remote', { naming: { allow: 'email' } }).charset).toBe('email');
    expect(correlationKeyPolicyFor('remote', {}).charset).toBe('sam');
  });
});
