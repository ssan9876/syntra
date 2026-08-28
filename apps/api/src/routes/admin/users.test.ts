import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createGroup,
  createOrgUnit,
  createPerson,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'a-long-enough-password';

/**
 * Hashed once for the whole file, outside every transaction.
 *
 * There is no helper that takes a plaintext and a transaction any more:
 * Argon2id is deliberately expensive and has no business inside Prisma's
 * 5000 ms budget, so `setPasswordHash` takes a hash and the hashing is the
 * caller's to place. Hashing once per file rather than once per test is the
 * same decision made cheaply.
 */
const PASSWORD_HASH = await hashPassword(PASSWORD);


async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
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
      await setPasswordHash(tx, created.id, PASSWORD_HASH);
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

/**
 * One account, read on its own.
 *
 * The account screen needs `locked`, the owning source and the person behind
 * the account, and before this the only way to get any of them was
 * `GET /users`, which returns the whole directory. Rendering one row by
 * fetching every row is a page that gets slower for reasons that have nothing
 * to do with the account being looked at.
 */
describe('GET /api/admin/users/:id', () => {
  it('returns the account with its lock state and the person behind it', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const { user, person } = await withTenant(ctx.tenantId, async (tx) => {
      const person = await createPerson(tx, {
        givenName: 'Maya',
        familyName: 'Okafor',
      });
      const user = await createUser(tx, {
        login: 'mokafor',
        email: 'maya@acme.test',
        displayName: 'Maya Okafor',
      });
      await tx.user.update({
        where: { id: user.id },
        data: { personId: person.id },
      });
      return { user, person };
    });

    const res = await get(`/api/admin/users/${user.id}`, cookie);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.login).toBe('mokafor');
    expect(body.displayName).toBe('Maya Okafor');
    expect(body.status).toBe('active');
    expect(body.sourceId).toBeNull();
    expect(body.passwordSource).toBe('local');
    // Locked is answered rather than omitted: the screen has to decide whether
    // to offer Unlock, and an absent field would read the same as "not locked".
    expect(body.locked).toBe(false);
    // Named, not just referenced. The account screen links back to the person
    // and cannot render "Maya Okafor" from an id alone.
    expect(body.person).toEqual({
      id: person.id,
      givenName: 'Maya',
      familyName: 'Okafor',
    });
  });

  it('says the account is locked while it is locked out', async () => {
    const admin = await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    await withTenant(ctx.tenantId, (tx) =>
      tx.loginLockout.create({
        data: {
          tenantId: ctx.tenantId,
          userId: admin.id,
          failedCount: 5,
          firstFailedAt: new Date(),
          lastFailedAt: new Date(),
          lockedAt: new Date(),
          lockedUntil: new Date(Date.now() + 60_000),
        },
      }),
    );

    const res = await get(`/api/admin/users/${admin.id}`, cookie);
    expect(res.json().locked).toBe(true);
  });

  it('reports an account with no person as having none', async () => {
    const admin = await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const res = await get(`/api/admin/users/${admin.id}`, cookie);
    expect(res.json().person).toBeNull();
  });

  it('answers 404 for an account that does not exist', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const res = await get(
      '/api/admin/users/00000000-0000-4000-8000-000000000000',
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });

  it('refuses a caller without directory.read', async () => {
    const admin = await seedAdmin([PERMISSIONS.IDENTITY_READ]);
    const cookie = await authCookie('admin');

    const res = await get(`/api/admin/users/${admin.id}`, cookie);
    expect(res.statusCode).toBe(403);
  });
});

/**
 * One group, read on its own.
 *
 * The record screen needs the group's own row -- its name, description, status
 * and the source that may own it -- and the only way to get any of it was
 * `GET /groups`, which returns every group in the tenant. Membership keeps its
 * own endpoint: it reloads on its own after an add or a remove, and folding it
 * in here would mean refetching the group to answer a question about somebody
 * else.
 */
describe('GET /api/admin/groups/:id', () => {
  it('returns the group with its description and status', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');

    const created = await post('/api/admin/groups', cookie, {
      name: 'Ward Nurses',
      description: 'Everyone rostered on a ward',
    });

    const res = await get(`/api/admin/groups/${created.json().id}`, cookie);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.id).toBe(created.json().id);
    expect(body.name).toBe('Ward Nurses');
    expect(body.description).toBe('Everyone rostered on a ward');
    expect(body.status).toBe('active');
    // Answered rather than omitted, for the same reason the account record
    // answers it: the screen decides from this whether to offer Edit at all.
    expect(body.sourceId).toBeNull();
  });

  it('keeps the reason a deactivated group was deactivated', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');

    const created = await post('/api/admin/groups', cookie, { name: 'Nurses' });
    await post(`/api/admin/groups/${created.json().id}/deactivate`, cookie, {
      reason: 'ward closed',
    });

    const res = await get(`/api/admin/groups/${created.json().id}`, cookie);
    expect(res.json().status).toBe('inactive');
    expect(res.json().statusReason).toBe('ward closed');
  });

  it('answers 404 for a group that does not exist', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const res = await get(
      '/api/admin/groups/00000000-0000-4000-8000-000000000000',
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });

  it('refuses a caller without directory.read', async () => {
    await seedAdmin([PERMISSIONS.IDENTITY_READ]);
    const cookie = await authCookie('admin');
    const group = await withTenant(ctx.tenantId, (tx) =>
      createGroup(tx, 'Nurses'),
    );

    const res = await get(`/api/admin/groups/${group.id}`, cookie);
    expect(res.statusCode).toBe(403);
  });
});

/**
 * One org unit, read on its own.
 *
 * A unit's record has to answer two questions the list cannot: who is sitting
 * in it, and what is beneath it. Both are the emptiness rule that refuses a
 * delete, and before this the only way to see either was to fetch the whole
 * directory and filter it in the browser -- which is a screen that gets slower
 * for reasons unrelated to the unit being looked at, and which cannot show a
 * parent's name without the tree it came from.
 */
describe('GET /api/admin/org-units/:id', () => {
  it('returns the unit with its parent named, the users in it, and its children', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const { head, finance, payroll, member } = await withTenant(
      ctx.tenantId,
      async (tx) => {
        const head = await createOrgUnit(tx, 'Head Office');
        const finance = await createOrgUnit(tx, 'Finance', head.id);
        const payroll = await createOrgUnit(tx, 'Payroll', finance.id);
        const member = await createUser(tx, {
          login: 'mokafor',
          email: 'maya@acme.test',
          displayName: 'Maya Okafor',
          orgUnitId: finance.id,
        });
        return { head, finance, payroll, member };
      },
    );

    const res = await get(`/api/admin/org-units/${finance.id}`, cookie);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.id).toBe(finance.id);
    expect(body.name).toBe('Finance');
    expect(body.status).toBe('active');
    expect(body.sourceId).toBeNull();
    // NAMED, not just referenced. The record links up to its parent and cannot
    // render "Head Office" from an id alone.
    expect(body.parent).toEqual({ id: head.id, name: 'Head Office' });
    expect(body.users).toEqual([
      {
        id: member.id,
        login: 'mokafor',
        displayName: 'Maya Okafor',
        status: 'active',
      },
    ]);
    expect(body.children).toEqual([
      { id: payroll.id, name: 'Payroll', status: 'active' },
    ]);
  });

  it('reports an empty top-level unit as empty rather than omitting it', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const unit = await withTenant(ctx.tenantId, (tx) =>
      createOrgUnit(tx, 'Head Office'),
    );

    const res = await get(`/api/admin/org-units/${unit.id}`, cookie);
    // Answered, not absent. The record decides from these whether to say the
    // unit is empty, and a missing field reads the same as one nobody looked up.
    expect(res.json().parent).toBeNull();
    expect(res.json().users).toEqual([]);
    expect(res.json().children).toEqual([]);
  });

  it('counts a deactivated user as still occupying the unit', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const unit = await withTenant(ctx.tenantId, async (tx) => {
      const unit = await createOrgUnit(tx, 'Finance');
      const leaver = await createUser(tx, {
        login: 'leaver',
        email: 'leaver@acme.test',
        displayName: 'A Leaver',
        orgUnitId: unit.id,
      });
      await tx.user.update({
        where: { id: leaver.id },
        data: { status: 'inactive' },
      });
      return unit;
    });

    const res = await get(`/api/admin/org-units/${unit.id}`, cookie);
    // The delete refuses while they are there, so the record has to show them.
    // Listing only active users would leave an administrator reading an empty
    // unit and a 409 that disagrees with it.
    expect(res.json().users).toHaveLength(1);
    expect(res.json().users[0].status).toBe('inactive');
  });

  it('answers 404 for a unit that does not exist', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const res = await get(
      '/api/admin/org-units/00000000-0000-4000-8000-000000000000',
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });

  it('refuses a caller without directory.read', async () => {
    await seedAdmin([PERMISSIONS.IDENTITY_READ]);
    const cookie = await authCookie('admin');
    const unit = await withTenant(ctx.tenantId, (tx) =>
      createOrgUnit(tx, 'Finance'),
    );

    const res = await get(`/api/admin/org-units/${unit.id}`, cookie);
    expect(res.statusCode).toBe(403);
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

/**
 * The link an administrator hands to a joiner who has no password.
 *
 * The route deliberately answers definitely -- 404 for an unknown user, 409
 * for a federated one -- where the anonymous reset endpoint answers uniformly.
 * A caller holding directory.write can already list every user, so there is no
 * account-existence oracle left to protect here.
 */
describe('password setup link', () => {
  it('returns a link an admin can hand over', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const joiner = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, { login: 'joiner', email: 'joiner@acme.test', displayName: 'Joiner' }),
    );

    const res = await post(`/api/admin/users/${joiner.id}/password-setup`, cookie, {});

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toMatch(/\/reset-password\?token=[A-Za-z0-9_-]+$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a caller without directory.write', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const joiner = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, { login: 'joiner', email: 'joiner@acme.test', displayName: 'Joiner' }),
    );

    const res = await post(`/api/admin/users/${joiner.id}/password-setup`, cookie, {});

    expect(res.statusCode).toBe(403);
    const count = await withTenant(ctx.tenantId, (tx) => tx.passwordResetToken.count());
    expect(count).toBe(0);
  });

  it('404s an unknown user', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');

    const res = await post(
      '/api/admin/users/00000000-0000-0000-0000-000000000000/password-setup',
      cookie,
      {},
    );

    expect(res.statusCode).toBe(404);
  });

  it('409s a user whose password lives upstream, and names where', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const federated = await withTenant(ctx.tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'fed',
        email: 'fed@acme.test',
        displayName: 'Fed',
      });
      return tx.user.update({
        where: { id: u.id },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Entra ID' },
      });
    });

    const res = await post(`/api/admin/users/${federated.id}/password-setup`, cookie, {});

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('Entra ID');
  });
});

describe('deleting a user', () => {
  const del = (url: string, cookie: string) =>
    ctx.app.inject({ method: 'DELETE', url, headers: { host: ctx.host, cookie } });

  /** A locally managed account with a person behind it. */
  async function seedLocalUser() {
    return withTenant(ctx.tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId: ctx.tenantId, givenName: 'Maya', familyName: 'Okafor' },
      });
      const user = await createUser(tx, {
        login: 'mokafor',
        email: 'maya@acme.test',
        displayName: 'Maya Okafor',
      });
      await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
      return { userId: user.id, personId: person.id };
    });
  }

  it('deletes the account and keeps the person', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.DIRECTORY_DELETE]);
    const cookie = await authCookie('admin');
    const { userId, personId } = await seedLocalUser();

    const res = await del(`/api/admin/users/${userId}`, cookie);

    expect(res.statusCode).toBe(204);
    await withTenant(ctx.tenantId, async (tx) => {
      expect(await tx.user.findUnique({ where: { id: userId } })).toBeNull();
      expect(await tx.person.findUnique({ where: { id: personId } })).not.toBeNull();
    });
  });

  it('refuses a caller who may write the directory but not delete from it', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const { userId } = await seedLocalUser();

    const res = await del(`/api/admin/users/${userId}`, cookie);

    // 403, and the account is still there. The separation is the point: this
    // caller can rename the account all day and cannot destroy it.
    expect(res.statusCode).toBe(403);
    await withTenant(ctx.tenantId, (tx) =>
      expect(tx.user.findUnique({ where: { id: userId } })).resolves.not.toBeNull(),
    );
  });

  it('answers 404 for a user that is not there', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.DIRECTORY_DELETE]);
    const cookie = await authCookie('admin');

    const res = await del(
      '/api/admin/users/00000000-0000-4000-8000-000000000000',
      cookie,
    );

    expect(res.statusCode).toBe(404);
  });

  it('explains a source that has not been allowed deletion, rather than 500ing', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.DIRECTORY_DELETE]);
    const cookie = await authCookie('admin');
    const { userId } = await seedLocalUser();
    const sourceId = await withTenant(ctx.tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: {
          tenantId: ctx.tenantId,
          name: 'Head office AD',
          type: 'ldap',
          config: {},
          secretName: 'unused',
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { sourceId: source.id, sourceAnchor: 'anchor-1' },
      });
      return source.id;
    });
    expect(sourceId).toBeTruthy();

    const res = await del(`/api/admin/users/${userId}`, cookie);

    // 409, not 403: the caller holds the permission, the CONFIGURATION does
    // not allow the write. And the detail says why deleting only the Syntra
    // row would be worse than refusing.
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('Head office AD');
    await withTenant(ctx.tenantId, (tx) =>
      expect(tx.user.findUnique({ where: { id: userId } })).resolves.not.toBeNull(),
    );
  });
});
