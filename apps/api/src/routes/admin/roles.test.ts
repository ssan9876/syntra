import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function seedAdmin(login: string, permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login,
      email: `${login}@acme.test`,
      displayName: login,
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id);
    return { user, roleId: role.id };
  });
}

async function authCookie(login: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  const token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const send = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
) =>
  ctx.app.inject(
    payload === undefined
      ? { method, url, headers: { host: ctx.host, cookie } }
      : { method, url, headers: { host: ctx.host, cookie }, payload: payload as object },
  );

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('the role API that did not exist', () => {
  it('lists roles with their holder counts, and the catalogue beside them', async () => {
    await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('GET', '/api/admin/roles', cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      catalog: string[];
      roles: { name: string; assignmentCount: number; permissions: string[] }[];
    };
    // The catalogue is on the response because the screen renders a checkbox
    // per permission and there is no other way for it to know the list.
    expect(body.catalog).toEqual([...ALL_PERMISSIONS]);
    expect(body.roles.find((r) => r.name === 'role-owner')?.assignmentCount).toBe(1);
  });

  /**
   * U3, closed from the product side. `deployment.manage` was added to the
   * catalogue in a later commit than the seed that wrote the Owner role, so
   * the Updates page was hidden and every update route answered 403 with no
   * path to grant it but SQL.
   */
  it('grants a permission the seed never wrote', async () => {
    const { roleId } = await seedAdmin('owner', [
      PERMISSIONS.RBAC_MANAGE,
      PERMISSIONS.DIRECTORY_READ,
    ]);
    const cookie = await authCookie('owner');

    const res = await send('PATCH', `/api/admin/roles/${roleId}`, cookie, {
      permissions: [
        PERMISSIONS.RBAC_MANAGE,
        PERMISSIONS.DIRECTORY_READ,
        PERMISSIONS.DEPLOYMENT_MANAGE,
      ],
    });
    expect(res.statusCode).toBe(204);

    const session = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: ctx.host, cookie },
    });
    expect((session.json() as { permissions: string[] }).permissions).toContain(
      'deployment.manage',
    );
  });

  it('names a permission it does not have, rather than dropping it', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('PATCH', `/api/admin/roles/${roleId}`, cookie, {
      permissions: ['directory.reed'],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      detail: expect.stringContaining('directory.reed'),
    });
  });

  it('creates, assigns and revokes', async () => {
    await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');
    const subject = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, { login: 'jo', email: 'jo@acme.test', displayName: 'Jo' }),
    );

    const created = await send('POST', '/api/admin/roles', cookie, {
      name: 'Auditor',
      permissions: [PERMISSIONS.AUDIT_READ],
    });
    expect(created.statusCode).toBe(201);
    const roleId = (created.json() as { id: string }).id;

    expect(
      (
        await send('POST', `/api/admin/roles/${roleId}/assignments`, cookie, {
          userId: subject.id,
        })
      ).statusCode,
    ).toBe(204);

    const listed = (await send('GET', '/api/admin/roles', cookie)).json() as {
      roles: { id: string; assignmentCount: number }[];
    };
    expect(listed.roles.find((r) => r.id === roleId)?.assignmentCount).toBe(1);

    expect(
      (await send('DELETE', `/api/admin/roles/${roleId}/assignments/${subject.id}`, cookie))
        .statusCode,
    ).toBe(204);
  });

  /**
   * THE GUARD THAT MATTERS MOST. Taking `rbac.manage` off the last role that
   * carries it leaves an installation nobody can administer roles in, which
   * is precisely the state this whole task exists to get out of, reached by
   * the very screen that fixes it.
   */
  it('refuses a change that leaves nobody able to administer roles', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('PATCH', `/api/admin/roles/${roleId}`, cookie, {
      permissions: [PERMISSIONS.DIRECTORY_READ],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: expect.stringContaining('would-strand-rbac'),
    });

    // And nothing was written: the guard runs inside the transaction.
    const still = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/roles',
      headers: { host: ctx.host, cookie },
    });
    expect(still.statusCode).toBe(200);
  });

  it('refuses revoking the last holder of rbac.manage', async () => {
    const { user, roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send(
      'DELETE',
      `/api/admin/roles/${roleId}/assignments/${user.id}`,
      cookie,
    );
    expect(res.statusCode).toBe(409);
  });

  it('allows the same change once somebody else holds it', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');
    await withTenant(ctx.tenantId, async (tx) => {
      const other = await createUser(tx, {
        login: 'second',
        email: 's@acme.test',
        displayName: 'S',
      });
      const role = await createRole(tx, 'Co-admin', [PERMISSIONS.RBAC_MANAGE]);
      await assignRole(tx, other.id, role.id);
    });

    const res = await send('PATCH', `/api/admin/roles/${roleId}`, cookie, {
      permissions: [PERMISSIONS.DIRECTORY_READ],
    });
    expect(res.statusCode).toBe(204);
  });

  it('requires rbac.manage', async () => {
    await seedAdmin('reader', [PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('reader');
    expect((await send('GET', '/api/admin/roles', cookie)).statusCode).toBe(403);
  });

  it('names who holds each role, not merely how many', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('GET', '/api/admin/roles', cookie);
    const role = (res.json() as { roles: { id: string; holders: unknown[] }[] }).roles.find(
      (r) => r.id === roleId,
    )!;

    // A count is not enough to revoke from: the screen showed "1 holder" and
    // had no way to say WHICH, so the only path to taking a role off somebody
    // was a database client. The login travels because RoleAssignment carries
    // a bare userId with no relation to User.
    expect(role.holders).toEqual([
      expect.objectContaining({ login: 'owner', scopeOrgUnitId: null }),
    ]);
  });

  it('assigns and revokes, and the holder list follows', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');
    const { user } = await seedAdmin('newcomer', [PERMISSIONS.DIRECTORY_READ]);

    const assigned = await send('POST', `/api/admin/roles/${roleId}/assignments`, cookie, {
      userId: user.id,
    });
    expect(assigned.statusCode).toBe(204);

    const after = await send('GET', '/api/admin/roles', cookie);
    const role = (
      after.json() as { roles: { id: string; holders: { login: string }[] }[] }
    ).roles.find((r) => r.id === roleId)!;
    expect(role.holders.map((h) => h.login).sort()).toEqual(['newcomer', 'owner']);

    const revoked = await send(
      'DELETE',
      `/api/admin/roles/${roleId}/assignments/${user.id}`,
      cookie,
    );
    expect(revoked.statusCode).toBe(204);

    const final = await send('GET', '/api/admin/roles', cookie);
    const finalRole = (
      final.json() as { roles: { id: string; holders: { login: string }[] }[] }
    ).roles.find((r) => r.id === roleId)!;
    expect(finalRole.holders.map((h) => h.login)).toEqual(['owner']);
  });

  it('answers 404 for an assignment to a user that is not there', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('POST', `/api/admin/roles/${roleId}/assignments`, cookie, {
      userId: '00000000-0000-4000-8000-000000000000',
    });

    // `findUniqueOrThrow` is there to validate the id, and problem-json
    // deliberately does not relabel a Prisma error -- so a well-formed but
    // unknown id (a stale row, a copied uuid) answered 500 with a stack trace
    // in the log, on a route whose whole job is validating two ids.
    expect(res.statusCode).toBe(404);
    expect(res.json().title).toMatch(/user/i);
  });

  it('answers 404 for an assignment against a role that is not there', async () => {
    await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');
    const { user } = await seedAdmin('other', [PERMISSIONS.DIRECTORY_READ]);

    const res = await send(
      'POST',
      '/api/admin/roles/00000000-0000-4000-8000-000000000000/assignments',
      cookie,
      { userId: user.id },
    );

    expect(res.statusCode).toBe(404);
    expect(res.json().title).toMatch(/role/i);
  });
});
