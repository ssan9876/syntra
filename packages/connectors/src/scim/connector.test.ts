import { describe, expect, it, afterEach } from 'vitest';
import { startFakeScimServer, type FakeScimServer } from '../testing/fake-scim-server.js';
import { scimTargetConnector } from './connector.js';

let server: FakeScimServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('scimTargetConnector.test', () => {
  it('reports ok against a reachable, correctly authenticated server', async () => {
    server = await startFakeScimServer({ bearerToken: 'secret-token' });
    const result = await scimTargetConnector.test({
      baseUrl: server.baseUrl,
      bearerToken: 'secret-token',
      allowPrivateAddresses: true,
    });
    expect(result.ok).toBe(true);
  });

  it('reports not ok when the bearer token is wrong', async () => {
    server = await startFakeScimServer({ bearerToken: 'secret-token' });
    const result = await scimTargetConnector.test({
      baseUrl: server.baseUrl,
      bearerToken: 'wrong-token',
      allowPrivateAddresses: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe('scimTargetConnector.discoverSchema', () => {
  it('falls back to the fixed core-schema attribute set when /Schemas is absent', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    const result = await scimTargetConnector.discoverSchema({
      baseUrl: server.baseUrl,
      bearerToken: 't',
      allowPrivateAddresses: true,
    });
    expect(result.attributes).toContain('userName');
    expect(result.attributes).toContain('externalId');
  });
});

describe('scimTargetConnector.read', () => {
  it('pages through every user and reports it as a SourceRecord', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: Array.from({ length: 3 }, (_, i) => ({
        id: `u-${i}`,
        userName: `person${i}`,
        externalId: null,
        active: true,
      })),
    });
    const records = [];
    for await (const record of scimTargetConnector.read({
      baseUrl: server.baseUrl,
      bearerToken: 't',
      pageSize: 2,
      allowPrivateAddresses: true,
    })) {
      records.push(record);
    }
    expect(records).toHaveLength(3);
    expect(records[0]!.anchor).toBe('u-0');
    expect(records[0]!.objectType).toBe('user');
    expect(records[0]!.attributes.userName).toEqual(['person0']);
  });
});

describe('scimTargetConnector.write — create, update, enable, disable', () => {
  const baseConfig = (s: FakeScimServer) => ({
    baseUrl: s.baseUrl,
    bearerToken: 't',
    userResourcePath: '/Users',
    groupResourcePath: '/Groups',
    pageSize: 200,
    connectTimeoutMs: 10_000,
    timeoutMs: 10_000,
    allowPrivateAddresses: true,
  });

  it('creates a user and returns its server-assigned id as the anchor', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    const result = await scimTargetConnector.write(baseConfig(server), {
      op: 'create_account',
      actionId: 'action-1',
      correlationKey: 'jdoe',
      attributes: { 'name.givenName': ['Jane'], 'name.familyName': ['Doe'] },
      enabled: true,
      initialPassword: 'S3cret!',
    });
    expect(result.ok).toBe(true);
    expect(result.anchor).toBeDefined();
    const created = server.users.get(result.anchor!);
    expect(created?.userName).toBe('jdoe');
    expect(created?.externalId).toBe('syntra-provision action=action-1');
  });

  it('updates the complete managed attribute set on an existing user', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'jdoe', externalId: null, active: true, title: 'old' }],
    });
    const result = await scimTargetConnector.write(baseConfig(server), {
      op: 'update_account',
      actionId: 'action-2',
      anchor: 'u-1',
      attributes: { title: ['new'] },
    });
    expect(result.ok).toBe(true);
    expect(server.users.get('u-1')?.title).toBe('new');
  });

  it('disables and re-enables a user by setting active', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'jdoe', externalId: null, active: true }],
    });
    const disabled = await scimTargetConnector.write(baseConfig(server), {
      op: 'disable_account',
      actionId: 'action-3',
      anchor: 'u-1',
      reason: 'left the org',
    });
    expect(disabled.ok).toBe(true);
    expect(server.users.get('u-1')?.active).toBe(false);

    const enabled = await scimTargetConnector.write(baseConfig(server), {
      op: 'enable_account',
      actionId: 'action-4',
      anchor: 'u-1',
    });
    expect(enabled.ok).toBe(true);
    expect(server.users.get('u-1')?.active).toBe(true);
  });

  it('reports not_found when the anchor names no resource', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    const result = await scimTargetConnector.write(baseConfig(server), {
      op: 'disable_account',
      actionId: 'action-5',
      anchor: 'no-such-id',
      reason: 'left the org',
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
  });
});

describe('scimTargetConnector.write — rename, archive, entitlements', () => {
  const baseConfig = (s: FakeScimServer) => ({
    baseUrl: s.baseUrl,
    bearerToken: 't',
    userResourcePath: '/Users',
    groupResourcePath: '/Groups',
    pageSize: 200,
    connectTimeoutMs: 10_000,
    timeoutMs: 10_000,
    allowPrivateAddresses: true,
  });

  it('renames by replacing userName', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'old-name', externalId: null, active: true }],
    });
    const result = await scimTargetConnector.write(baseConfig(server), {
      op: 'rename_account',
      actionId: 'action-1',
      anchor: 'u-1',
      correlationKey: 'new-name',
    });
    expect(result.ok).toBe(true);
    expect(server.users.get('u-1')?.userName).toBe('new-name');
  });

  it('archives by disabling and removing named group memberships, never deleting', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'jdoe', externalId: null, active: true }],
      groups: [{ id: 'g-1', displayName: 'staff', members: [{ value: 'u-1' }, { value: 'u-2' }] }],
    });
    const result = await scimTargetConnector.write(baseConfig(server), {
      op: 'archive_account',
      actionId: 'action-2',
      anchor: 'u-1',
      entitlementDns: ['g-1'],
    });
    expect(result.ok).toBe(true);
    expect(server.users.get('u-1')?.active).toBe(false);
    expect(server.users.has('u-1')).toBe(true); // never deleted
    expect(server.groups.get('g-1')?.members).toEqual([{ value: 'u-2' }]);
  });

  it('grants and revokes group membership', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'jdoe', externalId: null, active: true }],
      groups: [{ id: 'g-1', displayName: 'staff', members: [] }],
    });
    const granted = await scimTargetConnector.write(baseConfig(server), {
      op: 'grant_entitlement',
      actionId: 'action-3',
      anchor: 'u-1',
      entitlementId: 'g-1',
    });
    expect(granted.ok).toBe(true);
    expect(server.groups.get('g-1')?.members).toEqual([{ value: 'u-1' }]);

    const revoked = await scimTargetConnector.write(baseConfig(server), {
      op: 'revoke_entitlement',
      actionId: 'action-4',
      anchor: 'u-1',
      entitlementId: 'g-1',
    });
    expect(revoked.ok).toBe(true);
    expect(server.groups.get('g-1')?.members).toEqual([]);
  });
});

describe('scimTargetConnector — entitlements and containers', () => {
  const baseConfig = (s: FakeScimServer) => ({
    baseUrl: s.baseUrl,
    bearerToken: 't',
    userResourcePath: '/Users',
    groupResourcePath: '/Groups',
    pageSize: 200,
    connectTimeoutMs: 10_000,
    timeoutMs: 10_000,
    allowPrivateAddresses: true,
  });

  it('lists every group as a discovered entitlement', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      groups: [{ id: 'g-1', displayName: 'staff', members: [] }],
    });
    const found = [];
    for await (const entitlement of scimTargetConnector.listEntitlements(baseConfig(server))) {
      found.push(entitlement);
    }
    expect(found).toEqual([{ externalId: 'g-1', dn: 'g-1', type: 'group', displayName: 'staff' }]);
  });

  it('has no containers to list — SCIM has no organizational-unit concept', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    const found = [];
    for await (const container of scimTargetConnector.listContainers(baseConfig(server))) {
      found.push(container);
    }
    expect(found).toEqual([]);
  });

  it('reads every member of one entitlement in full', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      groups: [{ id: 'g-1', displayName: 'staff', members: [{ value: 'u-1' }, { value: 'u-2' }] }],
    });
    const members = await scimTargetConnector.readEntitlementMembers(baseConfig(server), 'g-1');
    expect(members).toEqual(['u-1', 'u-2']);
  });
});
