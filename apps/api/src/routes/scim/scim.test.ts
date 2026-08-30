import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  SCIM_USER_SCHEMA,
  assignRole,
  createRole,
  createScimSource,
  createUser,
  hashPassword,
  issueApiToken,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let token: string;
let readOnlyToken: string;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

/** A service account with `permissions`, and a token for it. */
async function tokenFor(permissions: Permission[], label: string) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: `svc-${label}`,
      email: `svc-${label}@acme.test`,
      displayName: `Service ${label}`,
    });
    const role = await createRole(tx, `Role ${label}`, permissions);
    await assignRole(tx, user.id, role.id);
    const issued = await issueApiToken(tx, {
      userId: user.id,
      name: label,
      scopes: [],
      expiresAt: null,
      createdBy: null,
    });
    return issued.token;
  });
}

const scim = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  bearer: string | null,
  payload?: unknown,
) =>
  ctx.app.inject({
    method,
    url: `/scim/v2${path}`,
    headers: {
      host: TEST_HOST,
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const createAda = (over: Record<string, unknown> = {}) =>
  scim('POST', '/Users', token, {
    schemas: [SCIM_USER_SCHEMA],
    userName: 'ada',
    externalId: 'e-1',
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    emails: [{ value: 'ada@acme.test', primary: true }],
    ...over,
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await withTenant(ctx.tenantId, (tx) => createScimSource(tx, { name: 'Entra' }));
  token = await tokenFor(
    [PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE],
    'rw',
  );
  readOnlyToken = await tokenFor([PERMISSIONS.DIRECTORY_READ], 'ro');
});

describe('authentication', () => {
  it('refuses an unauthenticated request in SCIM\'s error shape', async () => {
    const res = await scim('GET', '/Users', null);

    expect(res.statusCode).toBe(401);
    expect(res.json().schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
    // NOT problem+json. A client that cannot parse the error cannot tell a
    // conflict from a crash.
    expect(res.json()).not.toHaveProperty('type');
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('carries the status as a string, which the RFC requires', async () => {
    // A numeric status works against one client and fails against another.
    expect(await scim('GET', '/Users', null).then((r) => r.json().status)).toBe('401');
  });

  it('refuses a cookie session', async () => {
    // A browser has no business here, and every SCIM client sends a bearer
    // token.
    await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'person',
        email: 'person@acme.test',
        displayName: 'Person',
      });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
      const role = await createRole(tx, 'Admin', [PERMISSIONS.DIRECTORY_WRITE]);
      await assignRole(tx, user.id, role.id);
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: TEST_HOST },
      payload: { login: 'person', password: PASSWORD },
    });
    const cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('lets a read-only token read and not write', async () => {
    // A genuinely useful way to prove a connection before trusting it.
    expect((await scim('GET', '/Users', readOnlyToken)).statusCode).toBe(200);
    expect(
      (await scim('POST', '/Users', readOnlyToken, { userName: 'x' })).statusCode,
    ).toBe(403);
  });
});

describe('discovery', () => {
  it('serves ServiceProviderConfig, which Entra reads before it will provision', async () => {
    const res = await scim('GET', '/ServiceProviderConfig', token);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.patch.supported).toBe(true);
    expect(body.bulk.supported).toBe(false);
    expect(body.filter.supported).toBe(true);
    expect(body.filter.maxResults).toEqual(expect.any(Number));
  });

  it('says changePassword is not supported', async () => {
    // Before a client tries, rather than after it believes it worked.
    expect((await scim('GET', '/ServiceProviderConfig', token)).json().changePassword.supported)
      .toBe(false);
  });

  it('says plainly that DELETE deactivates', async () => {
    // The one place a client's administrator can learn this before an audit.
    const body = JSON.stringify((await scim('GET', '/ServiceProviderConfig', token)).json());

    expect(body).toMatch(/deactivat/i);
  });

  it('serves ResourceTypes and Schemas', async () => {
    expect((await scim('GET', '/ResourceTypes', token)).json().totalResults).toBe(2);
    expect((await scim('GET', '/Schemas', token)).json().totalResults).toBe(2);
  });
});

describe('the round trip an IdP performs at setup', () => {
  it('reads config, finds nothing, creates, and reads it back', async () => {
    expect((await scim('GET', '/ServiceProviderConfig', token)).statusCode).toBe(200);

    const empty = await scim('GET', '/Users?filter=userName eq "ada"', token);
    expect(empty.json().totalResults).toBe(0);

    const created = await createAda();
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toContain(created.json().id);

    const read = await scim('GET', `/Users/${created.json().id}`, token);
    expect(read.json().userName).toBe('ada');
    expect(read.json().externalId).toBe('e-1');
    expect(read.json().active).toBe(true);

    const found = await scim('GET', '/Users?filter=externalId eq "e-1"', token);
    expect(found.json().totalResults).toBe(1);
  });
});

describe('creating users', () => {
  it('answers 409 uniqueness for a second POST of one userName', async () => {
    await createAda();

    const again = await createAda();

    expect(again.statusCode).toBe(409);
    expect(again.json().scimType).toBe('uniqueness');
  });

  it('refuses to take over an account another source owns', async () => {
    // The account belongs to the system that anchored it.
    const ldapSourceId = await withTenant(ctx.tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: {
          tenantId: ctx.tenantId,
          name: 'AD',
          type: 'ldap',
          config: {},
          secretName: 'x',
        },
      });
      const user = await createUser(tx, {
        login: 'ada',
        email: 'ada@corp.test',
        displayName: 'Ada from AD',
      });
      await tx.user.update({ where: { id: user.id }, data: { sourceId: source.id } });
      return source.id;
    });

    const res = await createAda();

    expect(res.statusCode).toBe(409);
    const after = await withTenant(ctx.tenantId, (tx) =>
      tx.user.findFirstOrThrow({ where: { login: 'ada' } }),
    );
    expect(after.sourceId).toBe(ldapSourceId);
    expect(after.displayName).toBe('Ada from AD');
  });

  it('owns what it creates, so a hand edit is refused', async () => {
    // The existing rule, asserted for the new writer.
    const created = await createAda();
    const row = await withTenant(ctx.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: created.json().id } }),
    );

    expect(row.sourceId).not.toBeNull();
  });

  it('ignores a password entirely', async () => {
    // Syntra's password rules live in authorize() and the password services.
    const created = await createAda({ password: 'hunter2' });

    expect(JSON.stringify(created.json())).not.toContain('hunter2');
    const credential = await withTenant(ctx.tenantId, (tx) =>
      tx.passwordCredential.findFirst({ where: { userId: created.json().id } }),
    );
    expect(credential).toBeNull();
  });

  it('links a Person when both names are there', async () => {
    const created = await createAda();

    const row = await withTenant(ctx.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: created.json().id } }),
    );
    expect(row.personId).not.toBeNull();
  });

  it('creates no Person when the payload is only a login', async () => {
    // An IdP that knows a login and an address should not fill the register
    // with half-records no HR feed will reconcile against.
    const created = await scim('POST', '/Users', token, { userName: 'bare' });

    const row = await withTenant(ctx.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: created.json().id } }),
    );
    expect(row.personId).toBeNull();
  });

  it('creates an inactive account when active is false', async () => {
    const created = await createAda({ active: false });

    expect(created.json().active).toBe(false);
  });
});

describe('deactivating', () => {
  it('DELETE deactivates and does not delete', async () => {
    // THE assertion. This directory has no Delete, and SCIM does not get one.
    const created = await createAda();
    const id = created.json().id as string;

    expect((await scim('DELETE', `/Users/${id}`, token)).statusCode).toBe(204);

    const row = await withTenant(ctx.tenantId, (tx) =>
      tx.user.findUnique({ where: { id } }),
    );
    expect(row).not.toBeNull();
    expect(row!.status).toBe('inactive');
  });

  it('PATCH replace active:false deactivates, because that is what Entra sends', async () => {
    const created = await createAda();
    const id = created.json().id as string;

    const res = await scim('PATCH', `/Users/${id}`, token, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: false } }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
  });

  it('PATCH can reactivate', async () => {
    const created = await createAda({ active: false });
    const id = created.json().id as string;

    const res = await scim('PATCH', `/Users/${id}`, token, {
      Operations: [{ op: 'replace', path: 'active', value: true }],
    });

    expect(res.json().active).toBe(true);
  });

  it('refuses a PATCH path it does not implement, rather than reporting success', async () => {
    const created = await createAda();

    const res = await scim('PATCH', `/Users/${created.json().id}`, token, {
      Operations: [{ op: 'replace', path: 'title', value: 'Countess' }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().scimType).toBe('invalidPath');
  });
});

describe('listing', () => {
  it('refuses an unsupported filter, naming what works', async () => {
    const res = await scim('GET', '/Users?filter=userName co "ad"', token);

    expect(res.statusCode).toBe(400);
    expect(res.json().scimType).toBe('invalidFilter');
    expect(res.json().detail).toContain('userName');
  });

  it('paginates from 1 and refuses startIndex=0', async () => {
    // The RFC is 1-based. Silently reading 0 as 1 hides the client's bug
    // until a page is skipped.
    await createAda();

    expect((await scim('GET', '/Users?startIndex=1&count=1', token)).json().startIndex).toBe(1);
    expect((await scim('GET', '/Users?startIndex=0', token)).statusCode).toBe(400);
  });

  it('404s in SCIM\'s shape for an unknown user', async () => {
    const res = await scim('GET', '/Users/11111111-2222-4333-8444-555555555555', token);

    expect(res.statusCode).toBe(404);
    expect(res.json().schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });
});

describe('groups', () => {
  it('creates a group with members and reads them back', async () => {
    const ada = await createAda();

    const created = await scim('POST', '/Groups', token, {
      displayName: 'Engineering',
      externalId: 'g-1',
      members: [{ value: ada.json().id }],
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().displayName).toBe('Engineering');
    expect(created.json().members).toHaveLength(1);
  });

  it('adds and removes members by PATCH', async () => {
    const ada = await createAda();
    const group = await scim('POST', '/Groups', token, { displayName: 'Eng' });
    const id = group.json().id as string;

    const added = await scim('PATCH', `/Groups/${id}`, token, {
      Operations: [{ op: 'add', path: 'members', value: [{ value: ada.json().id }] }],
    });
    expect(added.json().members).toHaveLength(1);

    const removed = await scim('PATCH', `/Groups/${id}`, token, {
      Operations: [{ op: 'remove', path: 'members', value: [{ value: ada.json().id }] }],
    });
    expect(removed.json().members).toHaveLength(0);
  });

  it('refuses a member id that is not a user here, and changes nothing', async () => {
    // A partially applied membership is a state neither side knows it is in.
    const ada = await createAda();
    const res = await scim('POST', '/Groups', token, {
      displayName: 'Eng',
      members: [
        { value: ada.json().id },
        { value: '11111111-2222-4333-8444-555555555555' },
      ],
    });

    expect(res.statusCode).toBe(400);
    const groups = await withTenant(ctx.tenantId, (tx) => tx.group.count());
    expect(groups).toBe(0);
  });

  it('filters by displayName', async () => {
    await scim('POST', '/Groups', token, { displayName: 'Engineering' });

    const res = await scim('GET', '/Groups?filter=displayName eq "Engineering"', token);

    expect(res.json().totalResults).toBe(1);
  });

  it('DELETE deactivates the group and keeps the membership record', async () => {
    // Reactivating puts back exactly what was there, which a delete would
    // make impossible.
    const ada = await createAda();
    const group = await scim('POST', '/Groups', token, {
      displayName: 'Eng',
      members: [{ value: ada.json().id }],
    });
    const id = group.json().id as string;

    expect((await scim('DELETE', `/Groups/${id}`, token)).statusCode).toBe(204);

    const row = await withTenant(ctx.tenantId, (tx) => tx.group.findUnique({ where: { id } }));
    expect(row).not.toBeNull();
    expect(row!.status).toBe('inactive');
    const members = await withTenant(ctx.tenantId, (tx) =>
      tx.groupMembership.count({ where: { groupId: id } }),
    );
    expect(members).toBe(1);
  });
});

describe('audit', () => {
  it('records the service account as the actor', async () => {
    const created = await createAda();

    const event = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'scim.user_created' } }),
    );
    expect(event.targetId).toBe(created.json().id);
    expect(event.actorUserId).not.toBeNull();
  });

  it('carries no password in any payload', async () => {
    await createAda({ password: 'hunter2' });

    const events = await withTenant(ctx.tenantId, (tx) => tx.auditEvent.findMany());
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });
});
