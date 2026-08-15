import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  setPassword,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'a-long-enough-password';

async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPassword(tx, user.id, PASSWORD);
    if (permissions.length > 0) {
      const role = await createRole(tx, 'Custom', permissions);
      await assignRole(tx, user.id, role.id);
    }
    return user;
  });
}

/** Logs in and, when asked, elevates. Returns a Cookie header value. */
async function authCookie(scope: 'portal' | 'admin') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  let token = res.cookies.find((c) => c.name === 'syntra_session')!.value;

  if (scope === 'admin') {
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${token}` },
      payload: { password: PASSWORD },
    });
    token = up.cookies.find((c) => c.name === 'syntra_session')!.value;
  }
  return `syntra_session=${token}`;
}

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

const post = (url: string, cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('admin session separation', () => {
  it('rejects a portal session on an admin route', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('portal');

    const res = await get('/api/admin/users', cookie);

    // The permission is held; the session scope is not sufficient.
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe(
      'https://syntra.dev/problems/admin-session-required',
    );
  });

  it('rejects an anonymous caller', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { host: ctx.host },
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Offboarding is the whole point of a status column, and until this suite
 * existed nothing asserted that it reached a session already in flight.
 * `authorize.test.ts` covers the inactive principal, which made the property
 * look covered: it proves a deactivated user cannot *start* anything. It says
 * nothing about the session they are already holding, and the session is what
 * an administrator uses to write.
 *
 * Asserted at the requireSession layer rather than in a unit test, because
 * requireSession is what every admin route actually stands behind.
 */
describe('a deactivated user and a session already in flight', () => {
  /** Flips the status column only, leaving every session row untouched. */
  const disableWithoutRevoking = (id: string) =>
    withTenant(ctx.tenantId, (tx) =>
      tx.user.update({
        where: { id },
        data: { status: 'inactive', statusReason: 'left the company' },
      }),
    );

  it('refuses a privileged write the moment the administrator is deactivated', async () => {
    const admin = await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await authCookie('admin');

    // The session works, and it can write.
    expect((await get('/api/admin/users', cookie)).statusCode).toBe(200);

    const victim = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, {
        login: 'other',
        email: 'other@acme.test',
        displayName: 'Other',
      }),
    );
    const removed = await post(
      `/api/admin/users/${admin.id}/deactivate`,
      cookie,
      { reason: 'left the company' },
    );
    expect(removed.statusCode).toBe(200);

    // Same cookie, well inside its two-hour lifetime.
    expect((await get('/api/admin/users', cookie)).statusCode).toBe(401);
    const write = await post('/api/admin/policy/rules', cookie, {
      name: 'anything',
      outcome: 'deny',
    });
    expect(write.statusCode).toBe(401);
    expect(write.json().type).toBe(
      'https://syntra.dev/problems/unauthenticated',
    );

    // And they cannot deactivate anybody else on the way out either.
    const collateral = await post(
      `/api/admin/users/${victim.id}/deactivate`,
      cookie,
      { reason: 'spite' },
    );
    expect(collateral.statusCode).toBe(401);
  });

  it('refuses a session that predates the revoking deactivation', async () => {
    const admin = await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await authCookie('admin');
    expect((await get('/api/admin/users', cookie)).statusCode).toBe(200);

    // No revocation: this is the session issued by a path that forgot, or one
    // created before deactivateUser learned to revoke. resolveSession is the
    // half that has to catch it, and this is the test that says so.
    await disableWithoutRevoking(admin.id);

    expect((await get('/api/admin/users', cookie)).statusCode).toBe(401);
    expect(
      (
        await post('/api/admin/policy/rules', cookie, {
          name: 'anything',
          outcome: 'deny',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('refuses a deactivated portal user their own session too', async () => {
    const user = await withTenant(ctx.tenantId, async (tx) => {
      const created = await createUser(tx, {
        login: 'jdoe',
        email: 'j@acme.test',
        displayName: 'Jo Doe',
      });
      await setPassword(tx, created.id, PASSWORD);
      return created;
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'jdoe', password: PASSWORD },
    });
    const cookie = `syntra_session=${res.cookies.find((c) => c.name === 'syntra_session')!.value}`;
    expect((await get('/api/auth/session', cookie)).statusCode).toBe(200);

    await disableWithoutRevoking(user.id);

    expect((await get('/api/auth/session', cookie)).statusCode).toBe(401);
    expect((await get('/api/portal/applications', cookie)).statusCode).toBe(401);
  });
});

describe('permission enforcement', () => {
  it('allows a read with directory.read', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const res = await get('/api/admin/users', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().users).toHaveLength(1);
  });

  it('refuses a write when only directory.read is held', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const res = await post('/api/admin/users', cookie, {
      login: 'new',
      email: 'n@acme.test',
      displayName: 'New',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe('https://syntra.dev/problems/forbidden');
  });

  it('refuses a read when an unrelated permission is held', async () => {
    await seedAdmin([PERMISSIONS.SECRETS_WRITE]);
    const cookie = await authCookie('admin');

    const res = await get('/api/admin/users', cookie);
    expect(res.statusCode).toBe(403);
  });
});

describe('user administration', () => {
  const bothPermissions: Permission[] = [
    PERMISSIONS.DIRECTORY_READ,
    PERMISSIONS.DIRECTORY_WRITE,
  ];

  it('creates a user and records an audit event in the same transaction', async () => {
    await seedAdmin(bothPermissions);
    const cookie = await authCookie('admin');

    const res = await post('/api/admin/users', cookie, {
      login: 'new',
      email: 'n@acme.test',
      displayName: 'New',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().login).toBe('new');

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'user.create' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(res.json().id);
  });

  it('rejects a duplicate login with 409 and writes no audit event', async () => {
    await seedAdmin(bothPermissions);
    const cookie = await authCookie('admin');
    const payload = { login: 'new', email: 'n@acme.test', displayName: 'New' };

    await post('/api/admin/users', cookie, payload);
    const second = await post('/api/admin/users', cookie, payload);

    expect(second.statusCode).toBe(409);
    expect(second.json().type).toBe('https://syntra.dev/problems/conflict');

    // The failed attempt rolled back with its would-be audit entry.
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'user.create' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('rejects an invalid email with 400', async () => {
    await seedAdmin(bothPermissions);
    const cookie = await authCookie('admin');

    const res = await post('/api/admin/users', cookie, {
      login: 'new',
      email: 'not-an-email',
      displayName: 'New',
    });
    expect(res.statusCode).toBe(400);
  });

  it('deactivates rather than deletes', async () => {
    await seedAdmin(bothPermissions);
    const cookie = await authCookie('admin');

    const created = await post('/api/admin/users', cookie, {
      login: 'new',
      email: 'n@acme.test',
      displayName: 'New',
    });
    const id = created.json().id;

    const off = await post(`/api/admin/users/${id}/deactivate`, cookie, {
      reason: 'left the company',
    });
    expect(off.statusCode).toBe(200);

    const list = await get('/api/admin/users', cookie);
    const found = list
      .json()
      .users.find((u: { id: string }) => u.id === id);
    expect(found.status).toBe('inactive');
    expect(found.statusReason).toBe('left the company');
  });

  it('filters by status', async () => {
    await seedAdmin(bothPermissions);
    const cookie = await authCookie('admin');

    const created = await post('/api/admin/users', cookie, {
      login: 'new',
      email: 'n@acme.test',
      displayName: 'New',
    });
    await post(`/api/admin/users/${created.json().id}/deactivate`, cookie, {
      reason: 'left',
    });

    const active = await get('/api/admin/users?status=active', cookie);
    expect(
      active.json().users.map((u: { login: string }) => u.login),
    ).toEqual(['admin']);
  });

  it('returns 404 deactivating a user that does not exist', async () => {
    await seedAdmin(bothPermissions);
    const cookie = await authCookie('admin');

    const res = await post(
      '/api/admin/users/00000000-0000-4000-8000-000000000000/deactivate',
      cookie,
      { reason: 'nobody' },
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('group administration', () => {
  const permissions: Permission[] = [
    PERMISSIONS.DIRECTORY_READ,
    PERMISSIONS.DIRECTORY_WRITE,
  ];

  it('adds and removes a member', async () => {
    const admin = await seedAdmin(permissions);
    const cookie = await authCookie('admin');

    const group = await post('/api/admin/groups', cookie, { name: 'Nurses' });
    expect(group.statusCode).toBe(201);
    const groupId = group.json().id;

    const add = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/groups/${groupId}/members/${admin.id}`,
      headers: { host: ctx.host, cookie },
    });
    expect(add.statusCode).toBe(204);

    const members = await get(`/api/admin/groups/${groupId}/members`, cookie);
    expect(members.json().users).toHaveLength(1);

    const remove = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/groups/${groupId}/members/${admin.id}`,
      headers: { host: ctx.host, cookie },
    });
    expect(remove.statusCode).toBe(204);

    const after = await get(`/api/admin/groups/${groupId}/members`, cookie);
    expect(after.json().users).toEqual([]);
  });
});

describe('org unit administration', () => {
  it('creates a unit and nests one beneath it', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');

    const parent = await post('/api/admin/org-units', cookie, {
      name: 'Head Office',
    });
    expect(parent.statusCode).toBe(201);

    const child = await post('/api/admin/org-units', cookie, {
      name: 'Finance',
      parentId: parent.json().id,
    });
    expect(child.statusCode).toBe(201);
    expect(child.json().parentId).toBe(parent.json().id);

    const list = await get('/api/admin/org-units', cookie);
    expect(list.json().orgUnits).toHaveLength(2);
  });
});

describe('PATCH /api/admin/users/:id', () => {
  const patch = (url: string, cookie: string, payload: unknown) =>
    ctx.app.inject({
      method: 'PATCH',
      url,
      headers: { host: ctx.host, cookie },
      payload: payload as object,
    });

  it('moves a password upstream and records where it went', async () => {
    const admin = await seedAdmin([
      PERMISSIONS.DIRECTORY_READ,
      PERMISSIONS.DIRECTORY_WRITE,
    ]);
    const cookie = await authCookie('admin');

    const res = await patch(`/api/admin/users/${admin.id}`, cookie, {
      passwordSource: 'upstream',
      passwordSourceHint: 'Entra ID',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: admin.id,
      passwordSource: 'upstream',
      passwordSourceHint: 'Entra ID',
    });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'user.update' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('refuses the change without directory.write', async () => {
    const admin = await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const res = await patch(`/api/admin/users/${admin.id}`, cookie, {
      passwordSource: 'upstream',
    });
    expect(res.statusCode).toBe(403);
  });

  it('reports an unknown user as not found rather than as a fault', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');

    const res = await patch(
      '/api/admin/users/00000000-0000-4000-8000-000000000000',
      cookie,
      { passwordSource: 'upstream' },
    );
    expect(res.statusCode).toBe(404);
  });
});
