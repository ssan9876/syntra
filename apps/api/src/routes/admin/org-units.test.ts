import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
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

const BASE_DN = 'OU=Users,OU=Syntra,DC=acme,DC=test';

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: BASE_DN,
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
  provenanceAttribute: 'info',
};

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
  const token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const post = (url: string, cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

const del = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'DELETE', url, headers: { host: ctx.host, cookie } });

const ALL: Permission[] = [
  PERMISSIONS.DIRECTORY_READ,
  PERMISSIONS.DIRECTORY_WRITE,
  PERMISSIONS.PROVISION_READ,
  PERMISSIONS.PROVISION_MANAGE,
];

/** A unit and a target to materialise it against. */
async function seedUnitAndTarget() {
  return withTenant(ctx.tenantId, async (tx) => {
    const unit = await tx.orgUnit.create({
      data: { tenantId: ctx.tenantId, name: 'Sales' },
    });
    const target = await tx.targetSystem.create({
      data: {
        tenantId: ctx.tenantId,
        name: 'Acme AD',
        config,
        secretName: 'target/ad/bind',
      },
    });
    return { orgUnitId: unit.id, targetSystemId: target.id };
  });
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('materialising an org unit against a target', () => {
  it('refuses a DN outside the target base with 400, not 500', async () => {
    // The administrator's typo, on the field they just typed. It must come
    // back as a field error rather than an exception -- and it must never
    // reach the directory, because a materialisation pointing at CN=Users
    // would have Provision writing where the target config never said it
    // could.
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId, targetSystemId } = await seedUnitAndTarget();

    const res = await post(`/api/admin/org-units/${orgUnitId}/containers`, cookie, {
      targetSystemId,
      dn: 'CN=Users,DC=acme,DC=test',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('outside_base');
  });

  it('refuses a DN that is not a DN', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId, targetSystemId } = await seedUnitAndTarget();

    const res = await post(`/api/admin/org-units/${orgUnitId}/containers`, cookie, {
      targetSystemId,
      dn: 'Sales',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe('malformed');
  });

  it('answers 404 for an unknown org unit rather than a field error', async () => {
    // A stale page, not a typo, and it needs a different answer.
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { targetSystemId } = await seedUnitAndTarget();

    const res = await post(
      '/api/admin/org-units/00000000-0000-4000-8000-000000000000/containers',
      cookie,
      { targetSystemId, dn: `OU=Sales,${BASE_DN}` },
    );

    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for an unknown target', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId } = await seedUnitAndTarget();

    const res = await post(`/api/admin/org-units/${orgUnitId}/containers`, cookie, {
      targetSystemId: '00000000-0000-4000-8000-000000000000',
      dn: `OU=Sales,${BASE_DN}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses a caller without provision.manage', async () => {
    // Reading the directory is not permission to put a container in a domain.
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await adminCookie();
    const { orgUnitId, targetSystemId } = await seedUnitAndTarget();

    const res = await post(`/api/admin/org-units/${orgUnitId}/containers`, cookie, {
      targetSystemId,
      dn: `OU=Sales,${BASE_DN}`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('lists nothing for a unit that is not materialised anywhere', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId } = await seedUnitAndTarget();

    const res = await get(`/api/admin/org-units/${orgUnitId}/containers`, cookie);

    expect(res.statusCode).toBe(200);
    expect(res.json().containers).toEqual([]);
  });

  it('answers 404 when unmaterialising something that was never materialised', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId, targetSystemId } = await seedUnitAndTarget();

    const res = await del(
      `/api/admin/org-units/${orgUnitId}/containers/${targetSystemId}`,
      cookie,
    );

    expect(res.statusCode).toBe(404);
  });

  it('lists and then removes a materialisation', async () => {
    // Seeded directly rather than through POST: the POST reads the target's
    // live container inventory to decide between 'desired' and 'adopted', and
    // there is no directory here to read.
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId, targetSystemId } = await seedUnitAndTarget();
    await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnitContainer.create({
        data: {
          tenantId: ctx.tenantId,
          orgUnitId,
          targetSystemId,
          dn: `OU=Sales,${BASE_DN}`,
          state: 'desired',
        },
      }),
    );

    const listed = await get(`/api/admin/org-units/${orgUnitId}/containers`, cookie);
    expect(listed.json().containers).toEqual([
      {
        targetSystemId,
        targetName: 'Acme AD',
        dn: `OU=Sales,${BASE_DN}`,
        state: 'desired',
      },
    ]);

    const removed = await del(
      `/api/admin/org-units/${orgUnitId}/containers/${targetSystemId}`,
      cookie,
    );
    expect(removed.statusCode).toBe(204);

    const after = await get(`/api/admin/org-units/${orgUnitId}/containers`, cookie);
    expect(after.json().containers).toEqual([]);
  });

  it('does not remove the container itself when unmaterialising', async () => {
    // A container Syntra created and an administrator no longer wants tracked
    // is still a container full of accounts. Removing one is
    // DELETE /org-units/:id's business, and only once it is empty.
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId, targetSystemId } = await seedUnitAndTarget();
    await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnitContainer.create({
        data: {
          tenantId: ctx.tenantId,
          orgUnitId,
          targetSystemId,
          dn: `OU=Sales,${BASE_DN}`,
          state: 'live',
          anchor: 'anchor-1',
        },
      }),
    );

    await del(`/api/admin/org-units/${orgUnitId}/containers/${targetSystemId}`, cookie);

    // The unit is still there, and so is everything else. Nothing in this
    // endpoint can reach the directory at all.
    const units = await get('/api/admin/org-units', cookie);
    expect(units.json().orgUnits).toHaveLength(1);
  });
});
