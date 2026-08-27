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

/**
 * The placement routes.
 *
 * Written because the delegated-task admin routes shipped on the wrong path —
 * `/api/admin/tasks` where the console called `/api/admin/automate/tasks` —
 * and nothing caught it, because those routes had no test. These write to a
 * directory; they are the last ones that should be the untested set.
 *
 * The two endpoints that reach the TARGET (`/containers`, and the `PUT` that
 * performs the move) are deliberately not exercised here: both open a
 * connection to a real directory, and a test that stood one up would be
 * testing LDAP. `placement-service.test.ts` covers the decisions, and the
 * console's own tests cover the form. What is left, and what this file is
 * for, is that the paths resolve and the permissions bite.
 */

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let targetId: string;
let personId: string;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Custom', permissions);
    await assignRole(tx, user.id, role.id);
    return user;
  });
}

async function adminCookie() {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const portal = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  const seeded = await withTenant(ctx.tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Ada', familyName: 'Lovelace' },
    });
    const target = await tx.targetSystem.create({
      data: {
        tenantId: ctx.tenantId,
        name: 'AD',
        type: 'activeDirectory',
        // `target_system_encrypted_transport` refuses a target that could be
        // configured to write in the clear.
        config: { tlsMode: 'ldaps' },
        secretName: 'target:ad',
      },
    });
    return { personId: person.id, targetId: target.id };
  });
  personId = seeded.personId;
  targetId = seeded.targetId;
});

const path = () => `/api/admin/targets/${targetId}/placements/${personId}`;

describe('the placement routes', () => {
  it('need an administrative session', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: path(),
      headers: { host: ctx.host },
    });
    expect(res.statusCode).toBe(401);
  });

  it('answer null for somebody the rule places, rather than 404', async () => {
    // "This person follows the rule" is an answer, and the ordinary one. A 404
    // would make the common case look like an error on every person page.
    await seedAdmin([PERMISSIONS.PROVISION_READ]);
    const res = await call('GET', path(), await adminCookie());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ placement: null });
  });

  it('refuse a reader trying to clear a placement', async () => {
    // Clearing hands the person back to the rule, which the next run acts on.
    // That is a write, and `PROVISION_READ` is not enough for it.
    await seedAdmin([PERMISSIONS.PROVISION_READ]);
    expect((await call('DELETE', path(), await adminCookie())).statusCode).toBe(403);
  });

  it('let a manager clear one, idempotently', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();
    // Nothing to clear is what somebody pressing the button twice means.
    expect((await call('DELETE', path(), cookie)).statusCode).toBe(204);
    expect((await call('DELETE', path(), cookie)).statusCode).toBe(204);
  });

  it('return what was pinned once a placement exists', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    await withTenant(ctx.tenantId, (tx) =>
      tx.accountPlacement.create({
        data: {
          tenantId: ctx.tenantId,
          personId,
          targetSystemId: targetId,
          container: 'OU=Finance,OU=Company,DC=acme,DC=test',
          reason: 'moved after the reorg',
        },
      }),
    );

    const res = await call('GET', path(), await adminCookie());
    expect(res.json().placement).toMatchObject({
      container: 'OU=Finance,OU=Company,DC=acme,DC=test',
      reason: 'moved after the reorg',
    });
  });

  it('refuse a body that does not say why', async () => {
    // The row is a standing disagreement with the placement rule, and "who
    // moved this and why" is the only question anybody asks about one. A
    // reason nobody had to give is a reason nobody gives.
    await seedAdmin([...ALL_PERMISSIONS]);
    const res = await call('PUT', path(), await adminCookie(), {
      container: 'OU=Finance,OU=Company,DC=acme,DC=test',
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuse a malformed person id before reaching the target', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const res = await call(
      'GET',
      `/api/admin/targets/${targetId}/placements/not-a-uuid`,
      await adminCookie(),
    );
    expect(res.statusCode).toBe(400);
  });
});
