import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGraphServer, type FakeGraphServer } from '../testing/fake-graph-server.js';
import { entraTargetConnector } from './connector.js';
import { forgetEntraTokens } from './graph.js';
import { entraTargetConfigSchema, type EntraTargetConfig } from './config.js';
import { readBackTarget, type TargetConnector, type TargetReadBack } from '../types.js';
import { ENTRA_CAPABILITY_MATRIX } from './capabilities.js';

/**
 * Against the fake Graph in `testing/fake-graph-server.ts`. Real network
 * sockets on the loopback address, through `guardedFetch` with the private-
 * address guard lifted -- so the guard itself is exercised, once, by the
 * one test that leaves it on.
 *
 * What these prove is protocol handling: paging, `$batch`, `$ref` edges,
 * error classification, idempotency. What they cannot prove is Graph's own
 * behaviour, which is why `ENTRA_CAPABILITY_MATRIX` says which entries also
 * need tenant evidence from `entra/validate.ts`.
 */

const TENANT = 'contoso.example';
const CLIENT = '11111111-2222-3333-4444-555555555555';
const SECRET = 'the-client-secret';

const U1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const U2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const U3 = 'aaaaaaaa-0000-0000-0000-000000000003';
const U4 = 'aaaaaaaa-0000-0000-0000-000000000004';
const U5 = 'aaaaaaaa-0000-0000-0000-000000000005';
const G_SEC = 'bbbbbbbb-0000-0000-0000-000000000001';
const G_DYN = 'bbbbbbbb-0000-0000-0000-000000000002';
const G_MAIL = 'bbbbbbbb-0000-0000-0000-000000000003';
const G_M365 = 'bbbbbbbb-0000-0000-0000-000000000004';

let server: FakeGraphServer;

const seedUsers = () => [
  { id: U1, userPrincipalName: 'anna@contoso.example', displayName: 'Anna Novak', accountEnabled: true, department: 'Care', jobTitle: 'Nurse', employeeId: null },
  { id: U2, userPrincipalName: 'ben@contoso.example', displayName: 'Ben Okoro', accountEnabled: true, employeeId: null },
  { id: U3, userPrincipalName: 'cara@contoso.example', displayName: 'Cara Lund', accountEnabled: false, employeeId: null },
  { id: U4, userPrincipalName: 'dev@contoso.example', displayName: 'Dev Patel', accountEnabled: true, employeeId: null },
  { id: U5, userPrincipalName: 'eve@contoso.example', displayName: 'Eve Marsh', accountEnabled: true, employeeId: null },
];

const seedGroups = () => [
  { id: G_SEC, displayName: 'Finance', description: 'Finance staff', securityEnabled: true, mailEnabled: false, groupTypes: [], members: [U1, U2] },
  { id: G_DYN, displayName: 'All Nurses', securityEnabled: true, mailEnabled: false, groupTypes: ['DynamicMembership'], membershipRule: 'user.jobTitle -eq "Nurse"', members: [U1] },
  { id: G_MAIL, displayName: 'Finance Mail', securityEnabled: true, mailEnabled: true, groupTypes: [], members: [] },
  { id: G_M365, displayName: 'Team Site', securityEnabled: false, mailEnabled: true, groupTypes: ['Unified'], members: [] },
];

const config = (over: Partial<EntraTargetConfig> = {}, secret = SECRET) => ({
  tenantId: TENANT,
  clientId: CLIENT,
  graphBaseUrl: server.baseUrl,
  tokenUrl: server.tokenUrl,
  allowPrivateAddresses: true,
  ...over,
  bindPassword: secret,
});

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};

const graphRequests = () => server.requests.filter((r) => r.url.startsWith('/v1.0'));
const tokenRequests = () => server.requests.filter((r) => r.url.includes('/oauth2/'));

beforeEach(async () => {
  forgetEntraTokens();
  server = await startFakeGraphServer({
    tenantId: TENANT,
    clientId: CLIENT,
    clientSecret: SECRET,
    users: seedUsers(),
    groups: seedGroups(),
    pageSize: 2,
  });
});

afterEach(async () => {
  await server.close();
});

describe('configuration', () => {
  it('derives the token URL from the tenant and refuses unknown keys', () => {
    const parsed = entraTargetConfigSchema.parse({ tenantId: TENANT, clientId: CLIENT });
    expect(parsed.graphBaseUrl).toBe('https://graph.microsoft.com/v1.0');
    expect(parsed.correlationField).toBe('employeeId');
    expect(parsed.managedAttributes).toContain('familyName');
    expect(parsed.groupScope).toEqual({ securityEnabledOnly: true, includeMailEnabled: false });
    expect(() =>
      entraTargetConfigSchema.parse({ tenantId: TENANT, clientId: CLIENT, nestedGroups: true }),
    ).toThrow();
    expect(() => entraTargetConfigSchema.parse({ tenantId: 'not a tenant', clientId: CLIENT })).toThrow();
  });

  it('requires https unless the testing escape hatch is on', () => {
    expect(() =>
      entraTargetConfigSchema.parse({ tenantId: TENANT, clientId: CLIENT, tokenUrl: 'http://login.example/token' }),
    ).toThrow(/https/);
    expect(() =>
      entraTargetConfigSchema.parse({ tenantId: TENANT, clientId: CLIENT, graphBaseUrl: 'http://graph.example/v1.0' }),
    ).toThrow(/https/);
    expect(() =>
      entraTargetConfigSchema.parse({
        tenantId: TENANT,
        clientId: CLIENT,
        graphBaseUrl: 'http://127.0.0.1:1/v1.0',
        allowPrivateAddresses: true,
      }),
    ).not.toThrow();
  });

  it('never lists userPrincipalName as a managed attribute', () => {
    expect(() =>
      entraTargetConfigSchema.parse({
        tenantId: TENANT,
        clientId: CLIENT,
        managedAttributes: ['userPrincipalName'],
      }),
    ).toThrow();
  });
});

describe('OAuth', () => {
  it('reaches Graph with a valid secret and reports rights as unverified', async () => {
    const result = await entraTargetConnector.test(config());
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/reachable/);
    expect(result.sampleCounts?.user).toBe(1);
    expect(result.rights?.every((r) => r.status === 'unverified')).toBe(true);
    expect(result.rights?.[0]?.detail).toMatch(/admin consent/);
  });

  it('reports an invalid secret by its AADSTS code and never by the body', async () => {
    const result = await entraTargetConnector.test(config({}, 'wrong'));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/credential refused/);
    expect(result.message).toContain('AADSTS7000215');
    expect(result.message).not.toMatch(/Invalid client secret|wrong/);
  });

  it('fetches a new token after the secret is rotated, without a restart', async () => {
    await entraTargetConnector.test(config());
    expect(tokenRequests()).toHaveLength(1);

    // The same secret again: cached, no second exchange.
    await entraTargetConnector.test(config());
    expect(tokenRequests()).toHaveLength(1);

    // Rotated on both sides: the cache key includes a digest of the secret,
    // so the new secret cannot be served the old token.
    server.rotateSecret('rotated-secret');
    const rotated = await entraTargetConnector.test(config({}, 'rotated-secret'));
    expect(rotated.ok).toBe(true);
    expect(tokenRequests()).toHaveLength(2);

    // And forgetting is what a rotation calls: the next use exchanges again.
    forgetEntraTokens(CLIENT);
    await entraTargetConnector.test(config({}, 'rotated-secret'));
    expect(tokenRequests()).toHaveLength(3);
  });

  it('classifies a token refused after rotation as unauthorized on a write', async () => {
    server.rotateSecret('rotated-secret');
    const result = await entraTargetConnector.write(config(), {
      op: 'enable_account',
      actionId: 'a1',
      anchor: U3,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unauthorized');
    expect(result.message).toContain('AADSTS7000215');
  });
});

describe('read', () => {
  it('pages across a boundary with no omission and no duplicate', async () => {
    const records = await collect(entraTargetConnector.read(config()));
    expect(records.map((r) => r.anchor).sort()).toEqual([U1, U2, U3, U4, U5]);
    // Five users at a page size of two is three pages.
    expect(graphRequests().filter((r) => r.method === 'GET' && r.url.startsWith('/v1.0/users?')).length).toBe(3);
    // The nextLink is followed verbatim rather than rebuilt.
    const second = graphRequests().filter((r) => r.url.includes('skiptoken'))[0];
    expect(second?.url).toContain('%24select=');
  });

  it('reports identity, enabled state and direct memberships', async () => {
    const records = await collect(entraTargetConnector.read(config()));
    const anna = records.find((r) => r.anchor === U1)!;
    expect(anna.dn).toBe('anna@contoso.example');
    expect(anna.attributes.userPrincipalName).toEqual(['anna@contoso.example']);
    expect(anna.attributes.enabled).toEqual(['true']);
    expect(anna.attributes.accountEnabled).toEqual(['true']);
    expect(anna.attributes.department).toEqual(['Care']);
    expect(anna.attributes.title).toEqual(['Nurse']);
    expect([...(anna.attributes.memberOf ?? [])].sort()).toEqual([G_SEC, G_DYN].sort());
    const cara = records.find((r) => r.anchor === U3)!;
    expect(cara.attributes.enabled).toEqual(['false']);
    // Memberships travel through $batch, twenty users at a time.
    expect(graphRequests().some((r) => r.url === '/v1.0/$batch')).toBe(true);
  });

  it('sets readFailure on a user whose membership read failed, and drops nobody', async () => {
    server.failNext(1, 500, /memberOf/);
    const records = await collect(entraTargetConnector.read(config()));
    expect(records).toHaveLength(5);
    const failed = records.filter((r) => r.readFailure !== undefined);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.readFailure).toMatch(/HTTP 500/);
    expect(failed[0]?.attributes.memberOf).toBeUndefined();
    for (const record of records.filter((r) => r.readFailure === undefined)) {
      expect(record.attributes.memberOf).toBeDefined();
    }
  });

  it('retries only the throttled items of a batch', async () => {
    server.throttleNext(1, 0, /memberOf/);
    const records = await collect(entraTargetConnector.read(config()));
    expect(records.every((r) => r.readFailure === undefined)).toBe(true);
    expect(graphRequests().filter((r) => r.url === '/v1.0/$batch')).toHaveLength(2);
    const second = graphRequests().filter((r) => r.url === '/v1.0/$batch')[1]!;
    expect((second.body as { requests: unknown[] }).requests).toHaveLength(1);
  });
});

describe('entitlements', () => {
  it('lists security groups, excludes mail-enabled and Microsoft 365 groups by default, and marks dynamic groups', async () => {
    const listed = await collect(entraTargetConnector.listEntitlements(config()));
    expect(listed.map((e) => e.externalId).sort()).toEqual([G_SEC, G_DYN].sort());
    const finance = listed.find((e) => e.externalId === G_SEC)!;
    expect(finance).toMatchObject({ dn: G_SEC, type: 'group', displayName: 'Finance', description: 'Finance staff', manageable: true, membershipKind: 'assigned' });
    const dynamic = listed.find((e) => e.externalId === G_DYN)!;
    expect(dynamic.manageable).toBe(false);
    expect(dynamic.membershipKind).toBe('dynamic');
    expect(dynamic.unmanageableReason).toMatch(/dynamic/);
  });

  it('includes mail-enabled security groups when asked to', async () => {
    const listed = await collect(
      entraTargetConnector.listEntitlements(config({ groupScope: { includeMailEnabled: true } })),
    );
    expect(listed.map((e) => e.externalId)).toContain(G_MAIL);
    expect(listed.map((e) => e.externalId)).not.toContain(G_M365);
  });

  it('reads a full membership or throws', async () => {
    expect((await entraTargetConnector.readEntitlementMembers(config(), G_SEC)).sort()).toEqual([U1, U2].sort());
    server.failNext(1, 503, /members/);
    await expect(entraTargetConnector.readEntitlementMembers(config(), G_SEC)).rejects.toThrow(/HTTP 503/);
    await expect(entraTargetConnector.readEntitlementMembers(config(), 'no-such-group')).rejects.toThrow(/404/);
  });

  it('searches server-side and flags what cannot be managed', async () => {
    const found = await entraTargetConnector.searchEntitlements(config(), { query: 'fin' });
    expect(found.map((e) => e.displayName).sort()).toEqual(['Finance', 'Finance Mail']);
    expect(found.find((e) => e.displayName === 'Finance')?.manageable).toBe(true);
    expect(found.find((e) => e.displayName === 'Finance Mail')?.manageable).toBe(false);
    const search = graphRequests().find((r) => r.url.includes('%24search'));
    expect(search?.headers.consistencylevel).toBe('eventual');
    expect(search?.url).toContain('%24count=true');
  });

  it('falls back to startswith when $search is refused', async () => {
    server.failNext(1, 400, /%24search/);
    const found = await entraTargetConnector.searchEntitlements(config(), { query: 'All' });
    expect(found.map((e) => e.displayName)).toEqual(['All Nurses']);
    expect(graphRequests().some((r) => r.url.includes('startswith'))).toBe(true);
  });

  it('yields no containers and refuses to create one', async () => {
    expect(await collect(entraTargetConnector.listContainers(config()))).toEqual([]);
    const result = await entraTargetConnector.write(config(), { op: 'create_container', actionId: 'a', dn: 'OU=x' });
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toMatch(/no organizational units/);
  });
});

describe('create', () => {
  const create = (actionId: string, key = 'fay.wong') =>
    entraTargetConnector.write(config(), {
      op: 'create_account',
      actionId,
      correlationKey: key,
      attributes: { displayName: ['Fay Wong'], givenName: ['Fay'], familyName: ['Wong'], title: ['Analyst'] },
      enabled: true,
      initialPassword: 'Initial-Passw0rd!',
    });

  it('creates once and adopts on the second attempt of the same action', async () => {
    const first = await create('action-1');
    expect(first.ok).toBe(true);
    expect(first.anchor).toBeDefined();
    const created = server.users.get(first.anchor!)!;
    expect(created.userPrincipalName).toBe('fay.wong@contoso.example');
    expect(created.mailNickname).toBe('fay.wong');
    expect(created.surname).toBe('Wong');
    expect(created.jobTitle).toBe('Analyst');
    expect(created.employeeId).toBe('action-1');
    expect(created.accountEnabled).toBe(true);
    const post = graphRequests().find((r) => r.method === 'POST' && r.url === '/v1.0/users')!;
    expect((post.body as { passwordProfile: { forceChangePasswordNextSignIn: boolean } }).passwordProfile.forceChangePasswordNextSignIn).toBe(true);

    const second = await create('action-1');
    expect(second.ok).toBe(true);
    expect(second.anchor).toBe(first.anchor);
    expect(second.message).toMatch(/adopted/);
    expect([...server.users.values()].filter((u) => u.userPrincipalName.startsWith('fay.wong'))).toHaveLength(1);
    expect(graphRequests().filter((r) => r.method === 'POST' && r.url === '/v1.0/users')).toHaveLength(1);
  });

  it('records the marker in an extension attribute when configured, with an advanced query', async () => {
    const cfg = config({ correlationField: 'extensionAttribute3' });
    const first = await entraTargetConnector.write(cfg, {
      op: 'create_account',
      actionId: 'action-x',
      correlationKey: 'gil@contoso.example',
      attributes: {},
      enabled: false,
      initialPassword: 'Initial-Passw0rd!',
    });
    expect(first.ok).toBe(true);
    expect(server.users.get(first.anchor!)?.onPremisesExtensionAttributes).toEqual({ extensionAttribute3: 'action-x' });
    const lookup = graphRequests().find((r) => r.url.includes('onPremisesExtensionAttributes'))!;
    expect(lookup.headers.consistencylevel).toBe('eventual');
    const again = await entraTargetConnector.write(cfg, {
      op: 'create_account',
      actionId: 'action-x',
      correlationKey: 'gil@contoso.example',
      attributes: {},
      enabled: false,
      initialPassword: 'Initial-Passw0rd!',
    });
    expect(again.anchor).toBe(first.anchor);
  });

  it('reports a taken userPrincipalName as a conflict', async () => {
    const result = await create('action-2', 'anna');
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('conflict');
    expect(result.message).toContain('anna@contoso.example');
    expect(result.message).not.toContain('Another object');
  });

  it('refuses a bare correlation key when the tenant is a directory id', async () => {
    const result = await entraTargetConnector.write(
      config({ tenantId: '99999999-8888-7777-6666-555555555555' }),
      {
        op: 'create_account',
        actionId: 'action-3',
        correlationKey: 'hal.jordan',
        attributes: {},
        enabled: true,
        initialPassword: 'Initial-Passw0rd!',
      },
    );
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toMatch(/no domain/);
    expect(graphRequests().some((r) => r.method === 'POST')).toBe(false);
  });

  it('never treats a failed marker lookup as "not found"', async () => {
    server.failNext(1, 503, /%24filter/);
    const result = await create('action-4');
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('transient');
    expect(graphRequests().some((r) => r.method === 'POST' && r.url === '/v1.0/users')).toBe(false);
  });
});

describe('update, enable, disable, rename, archive', () => {
  it('changes only the managed field and leaves unmanaged fields untouched', async () => {
    server.users.get(U1)!.officeLocation = 'Ward 3';
    server.users.get(U1)!.otherMails = ['anna@personal.example'];
    const result = await entraTargetConnector.write(config({ managedAttributes: ['department'] }), {
      op: 'update_account',
      actionId: 'a',
      anchor: U1,
      attributes: { department: ['Surgery'], title: ['Consultant'], userPrincipalName: ['hijack@evil.example'], employeeId: ['x'] },
    });
    expect(result.ok).toBe(true);
    const anna = server.users.get(U1)!;
    expect(anna.department).toBe('Surgery');
    expect(anna.jobTitle).toBe('Nurse');
    expect(anna.officeLocation).toBe('Ward 3');
    expect(anna.otherMails).toEqual(['anna@personal.example']);
    expect(anna.userPrincipalName).toBe('anna@contoso.example');
    expect(anna.employeeId).toBeNull();
    const patch = graphRequests().find((r) => r.method === 'PATCH')!;
    expect(patch.body).toEqual({ department: 'Surgery' });
  });

  it('disables and leaves the account present', async () => {
    const result = await entraTargetConnector.write(config(), { op: 'disable_account', actionId: 'a', anchor: U1, reason: 'left' });
    expect(result.ok).toBe(true);
    expect(server.users.get(U1)?.accountEnabled).toBe(false);
    expect(server.users.has(U1)).toBe(true);
    const back = await entraTargetConnector.readBack(config(), U1);
    expect(back.enabled).toBe(false);
    expect(back.complete).toBe(true);
    const enabled = await entraTargetConnector.write(config(), { op: 'enable_account', actionId: 'a', anchor: U1 });
    expect(enabled.ok).toBe(true);
    expect(server.users.get(U1)?.accountEnabled).toBe(true);
  });

  it('renames the principal name and mail nickname', async () => {
    const result = await entraTargetConnector.write(config(), { op: 'rename_account', actionId: 'a', anchor: U1, correlationKey: 'anna.novak' });
    expect(result.ok).toBe(true);
    expect(server.users.get(U1)?.userPrincipalName).toBe('anna.novak@contoso.example');
    expect(server.users.get(U1)?.mailNickname).toBe('anna.novak');
  });

  it('archives by revoking the managed memberships and disabling, and never deletes', async () => {
    const result = await entraTargetConnector.write(config(), {
      op: 'archive_account',
      actionId: 'a',
      anchor: U1,
      entitlementDns: [G_SEC],
    });
    expect(result.ok).toBe(true);
    expect(server.groups.get(G_SEC)?.members).not.toContain(U1);
    // Not in the list handed to it: the dynamic group's membership is
    // untouched, because "Provision manages this target" is not "Provision
    // manages every group in it".
    expect(server.groups.get(G_DYN)?.members).toContain(U1);
    expect(server.users.get(U1)?.accountEnabled).toBe(false);
    expect(server.users.has(U1)).toBe(true);
    expect(graphRequests().some((r) => r.method === 'DELETE' && /\/users\//.test(r.url))).toBe(false);
  });

  it('stops an archive at the first membership it cannot remove', async () => {
    server.failNext(1, 503, /members/);
    const result = await entraTargetConnector.write(config(), {
      op: 'archive_account',
      actionId: 'a',
      anchor: U1,
      entitlementDns: [G_SEC],
    });
    expect(result).toMatchObject({ ok: false, failure: 'transient' });
    expect(server.users.get(U1)?.accountEnabled).toBe(true);
  });
});

describe('group membership', () => {
  it('adds then removes a direct membership, observed by readBack after each', async () => {
    const before = await entraTargetConnector.readBack(config(), U3);
    expect(before.entitlementIds).toEqual([]);

    const granted = await entraTargetConnector.write(config(), { op: 'grant_entitlement', actionId: 'a', anchor: U3, entitlementId: G_SEC });
    expect(granted.ok).toBe(true);
    const afterGrant = await entraTargetConnector.readBack(config(), U3);
    expect(afterGrant.entitlementIds).toEqual([G_SEC]);
    expect(afterGrant.complete).toBe(true);
    expect(afterGrant.account?.attributes.memberOf).toEqual([G_SEC]);

    const again = await entraTargetConnector.write(config(), { op: 'grant_entitlement', actionId: 'a', anchor: U3, entitlementId: G_SEC });
    expect(again.ok).toBe(true);
    expect(again.message).toMatch(/already present/);

    const revoked = await entraTargetConnector.write(config(), { op: 'revoke_entitlement', actionId: 'b', anchor: U3, entitlementId: G_SEC });
    expect(revoked.ok).toBe(true);
    const afterRevoke = await entraTargetConnector.readBack(config(), U3);
    expect(afterRevoke.entitlementIds).toEqual([]);

    const absent = await entraTargetConnector.write(config(), { op: 'revoke_entitlement', actionId: 'c', anchor: U3, entitlementId: G_SEC });
    expect(absent.ok).toBe(true);
    expect(absent.message).toMatch(/already absent/);
  });

  it('refuses to grant a dynamic group before making any request', async () => {
    const result = await entraTargetConnector.write(config(), { op: 'grant_entitlement', actionId: 'a', anchor: U2, entitlementId: G_DYN });
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toMatch(/dynamic/);
    expect(graphRequests().some((r) => r.method === 'POST' && r.url.includes('$ref'))).toBe(false);
    expect(server.groups.get(G_DYN)?.members).not.toContain(U2);
  });

  it('distinguishes a missing group from an absent membership on revoke', async () => {
    const result = await entraTargetConnector.write(config(), { op: 'revoke_entitlement', actionId: 'a', anchor: U1, entitlementId: 'cccccccc-0000-0000-0000-000000000000' });
    expect(result).toMatchObject({ ok: false, failure: 'not_found' });
  });
});

describe('read-back', () => {
  it('reports the account, enabled state and memberships', async () => {
    const back = await entraTargetConnector.readBack(config(), U1);
    expect(back.account?.anchor).toBe(U1);
    expect(back.enabled).toBe(true);
    expect(back.entitlementIds.sort()).toEqual([G_SEC, G_DYN].sort());
    expect(back.complete).toBe(true);
  });

  it('is incomplete when the membership read fails', async () => {
    server.failNext(1, 503, /memberOf/);
    const back = await entraTargetConnector.readBack(config(), U1);
    expect(back.account?.anchor).toBe(U1);
    expect(back.account?.readFailure).toMatch(/503/);
    expect(back.enabled).toBe(true);
    expect(back.complete).toBe(false);
  });

  it('never claims a delayed create or membership as verified', async () => {
    server.delayVisibility(2);
    const created = await entraTargetConnector.write(config(), {
      op: 'create_account',
      actionId: 'late',
      correlationKey: 'late@contoso.example',
      attributes: { displayName: ['Late Arrival'] },
      enabled: true,
      initialPassword: 'Initial-Passw0rd!',
    });
    expect(created.ok).toBe(true);
    const first = await entraTargetConnector.readBack(config(), created.anchor!);
    expect(first.account).toBeNull();
    expect(first.enabled).toBeNull();
    // Reads later, Graph shows it.
    await entraTargetConnector.readBack(config(), created.anchor!);
    const settled = await entraTargetConnector.readBack(config(), created.anchor!);
    expect(settled.account?.anchor).toBe(created.anchor);

    // Two reads: the read-back GETs the user before it walks memberOf.
    server.delayVisibility(2);
    await entraTargetConnector.write(config(), { op: 'grant_entitlement', actionId: 'a', anchor: U3, entitlementId: G_SEC });
    const mismatch = await entraTargetConnector.readBack(config(), U3);
    expect(mismatch.entitlementIds).not.toContain(G_SEC);
    const visible = await entraTargetConnector.readBack(config(), U3);
    expect(visible.entitlementIds).toContain(G_SEC);
  });

  it('is what readBackTarget uses when the connector offers it', async () => {
    const back = await readBackTarget(entraTargetConnector, config(), U1);
    expect(back.entitlementIds.sort()).toEqual([G_SEC, G_DYN].sort());
    // One GET of the user plus one membership walk: no directory enumeration.
    expect(graphRequests().some((r) => r.url.startsWith('/v1.0/users?'))).toBe(false);
  });
});

describe('readBackTarget', () => {
  it('prefers a connector-provided readBack over enumerating the directory', async () => {
    let enumerated = false;
    const own: TargetReadBack = { account: null, entitlementIds: ['x'], enabled: true, complete: true };
    const connector = {
      async test() { return { ok: true, message: '' }; },
      async discoverSchema() { return { objectClasses: [], attributes: [] }; },
      async *read() { enumerated = true; yield* []; },
      async write() { return { ok: true, message: '' }; },
      async *listEntitlements() {},
      async *listContainers() {},
      async readEntitlementMembers() { return []; },
      async readBack() { return own; },
    } satisfies TargetConnector<unknown> & { readBack(): Promise<TargetReadBack> };
    expect(await readBackTarget(connector, {}, 'anchor')).toBe(own);
    expect(enumerated).toBe(false);
  });
});

describe('failure classification', () => {
  const disable = () => entraTargetConnector.write(config(), { op: 'disable_account', actionId: 'a', anchor: U1, reason: 'r' });

  it('429 is throttled and carries Retry-After', async () => {
    server.throttleNext(1, 7, /PATCH/);
    const result = await disable();
    expect(result).toMatchObject({ ok: false, failure: 'throttled', retryAfterMs: 7000 });
    expect(result.message).toMatch(/HTTP 429 \(TooManyRequests\)/);
  });

  it('403 is unauthorized and names the consent problem on test', async () => {
    server.consentDenied();
    const result = await disable();
    expect(result).toMatchObject({ ok: false, failure: 'unauthorized' });
    expect(result.message).toContain('Authorization_RequestDenied');
    expect(result.message).not.toContain('Insufficient privileges');
    const probe = await entraTargetConnector.test(config());
    expect(probe.ok).toBe(false);
    expect(probe.message).toMatch(/consent missing/);
  });

  it('401 is unauthorized', async () => {
    server.revokeAuth();
    expect(await disable()).toMatchObject({ ok: false, failure: 'unauthorized' });
    const probe = await entraTargetConnector.test(config());
    expect(probe.message).toMatch(/credential refused/);
  });

  it('404 is not_found', async () => {
    const result = await entraTargetConnector.write(config(), { op: 'update_account', actionId: 'a', anchor: 'no-such-user', attributes: { department: ['x'] } });
    expect(result).toMatchObject({ ok: false, failure: 'not_found' });
  });

  it('503 is transient', async () => {
    server.failNext(1, 503, /PATCH/);
    expect(await disable()).toMatchObject({ ok: false, failure: 'transient' });
  });

  it('an unreachable endpoint is transient, not a crash', async () => {
    const result = await entraTargetConnector.write(
      config({ graphBaseUrl: 'http://127.0.0.1:1/v1.0' }),
      { op: 'enable_account', actionId: 'a', anchor: U1 },
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('transient');
  });
});

describe('the outbound guard', () => {
  it('blocks a private address unless allowPrivateAddresses is set', async () => {
    // https, so the schema lets it through to the guard, which refuses the
    // loopback address before any socket is opened.
    const result = await entraTargetConnector.test(
      config({
        allowPrivateAddresses: false,
        graphBaseUrl: 'https://127.0.0.1:9/v1.0',
        tokenUrl: 'https://127.0.0.1:9/token',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/own network/);
    expect(server.requests).toHaveLength(0);
  });
});

describe('the capability matrix', () => {
  it('never advertises delete and never advertises nested or dynamic groups', () => {
    expect(ENTRA_CAPABILITY_MATRIX.version).toBe(1);
    expect(ENTRA_CAPABILITY_MATRIX.entries.deleteAccount.status).toBe('never');
    expect(ENTRA_CAPABILITY_MATRIX.entries.nestedGroups.status).toBe('unsupported');
    expect(ENTRA_CAPABILITY_MATRIX.entries.dynamicGroups.status).toBe('unsupported');
    for (const entry of Object.values(ENTRA_CAPABILITY_MATRIX.entries)) {
      expect(entry.note.length).toBeGreaterThan(20);
    }
  });
});
