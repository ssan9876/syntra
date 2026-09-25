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
  PERMISSIONS.DIRECTORY_DELETE,
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
        source: 'manual',
        previousDn: null,
        mirroring: false,
        mirrored: false,
        derivedDn: null,
        problem: null,
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

describe('a target mirroring org units as OUs', () => {
  const mirroring = async (targetSystemId: string) =>
    withTenant(ctx.tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetSystemId }, data: { mirrorOrgUnits: true } }),
    );

  it('shows the derived DN, marked mirrored, before any run has made it', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId, targetSystemId } = await seedUnitAndTarget();
    await mirroring(targetSystemId);

    const res = await get(`/api/admin/org-units/${orgUnitId}/containers`, cookie);

    expect(res.json().containers).toEqual([
      expect.objectContaining({
        targetSystemId,
        dn: `OU=Sales,${BASE_DN}`,
        state: 'derived',
        source: 'mirrored',
        mirrored: true,
      }),
    ]);
  });

  it('switches a manual row to mirrored, recording the move it implies', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId, targetSystemId } = await seedUnitAndTarget();
    await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnitContainer.create({
        data: { tenantId: ctx.tenantId, orgUnitId, targetSystemId, dn: `OU=Flat,${BASE_DN}`, state: 'live', source: 'manual' },
      }),
    );
    const refused = await post(
      `/api/admin/org-units/${orgUnitId}/containers/${targetSystemId}/switch-to-mirrored`,
      cookie,
      {},
    );
    expect(refused.statusCode).toBe(409);

    await mirroring(targetSystemId);
    const res = await post(
      `/api/admin/org-units/${orgUnitId}/containers/${targetSystemId}/switch-to-mirrored`,
      cookie,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ targetSystemId, dn: `OU=Sales,${BASE_DN}`, pendingMoveFrom: `OU=Flat,${BASE_DN}` });
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'orgUnit.container.switch_to_mirrored' } }),
    );
    expect(events).toHaveLength(1);
  });
});

describe('switching every hand-typed unit on a target to mirrored', () => {
  // The live case: every unit was materialised by hand before mirroring
  // existed, mirroring was turned on, and nothing moved -- because a typed DN
  // always wins. The bulk switch is that one button pressed for each unit.
  const url = (targetSystemId: string) => `/api/admin/targets/${targetSystemId}/org-units/switch-to-mirrored`;

  /** Corp > IT, plus an inactive Old unit, all typed by hand on a mirroring target. */
  async function seedHandTypedTree() {
    return withTenant(ctx.tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: { tenantId: ctx.tenantId, name: 'Acme AD', config, secretName: 'target/ad/bind', mirrorOrgUnits: true },
      });
      const other = await tx.targetSystem.create({
        data: { tenantId: ctx.tenantId, name: 'Other AD', config, secretName: 'target/ad/bind2', mirrorOrgUnits: true },
      });
      // Created child first, so "parents first" cannot pass by insertion order.
      const corp = await tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Corp' } });
      const it = await tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'IT', parentId: corp.id } });
      const old = await tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Old', status: 'inactive' } });
      const row = (orgUnitId: string, targetSystemId: string, dn: string) =>
        tx.orgUnitContainer.create({
          data: { tenantId: ctx.tenantId, orgUnitId, targetSystemId, dn, state: 'live', source: 'manual' },
        });
      await row(it.id, target.id, `OU=IT,${BASE_DN}`);
      await row(corp.id, target.id, `OU=Corp,${BASE_DN}`);
      await row(old.id, target.id, `OU=Old,${BASE_DN}`);
      await row(corp.id, other.id, `OU=Corp,${BASE_DN}`);
      return { targetId: target.id, otherId: other.id, corpId: corp.id, itId: it.id, oldId: old.id };
    });
  }

  it('converts only manual rows of active units on that target, parents first, auditing each', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const seeded = await seedHandTypedTree();

    const res = await post(url(seeded.targetId), cookie, {});

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.switched.map((s: { unitName: string }) => s.unitName)).toEqual(['Corp', 'IT']);
    expect(body.switched[1]).toEqual({
      orgUnitId: seeded.itId,
      unitName: 'IT',
      from: `OU=IT,${BASE_DN}`,
      dn: `OU=IT,OU=Corp,${BASE_DN}`,
      pendingMoveFrom: `OU=IT,${BASE_DN}`,
    });
    expect(body.skipped).toEqual([]);

    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnitContainer.findMany({ select: { orgUnitId: true, targetSystemId: true, source: true } }),
    );
    const sourceOf = (orgUnitId: string, targetSystemId: string) =>
      rows.find((r) => r.orgUnitId === orgUnitId && r.targetSystemId === targetSystemId)?.source;
    expect(sourceOf(seeded.corpId, seeded.targetId)).toBe('mirrored');
    expect(sourceOf(seeded.itId, seeded.targetId)).toBe('mirrored');
    // A deactivated unit is not mirrored at all: its typed row still says
    // where its OU is, and stays.
    expect(sourceOf(seeded.oldId, seeded.targetId)).toBe('manual');
    // Another target's typed row is that target's business.
    expect(sourceOf(seeded.corpId, seeded.otherId)).toBe('manual');

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: 'orgUnit.container.switch_to_mirrored' },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(events.map((e) => e.targetId)).toEqual([seeded.corpId, seeded.itId]);
  });

  it('is idempotent: a second press converts nothing and audits nothing', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const seeded = await seedHandTypedTree();

    await post(url(seeded.targetId), cookie, {});
    const again = await post(url(seeded.targetId), cookie, {});

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ targetSystemId: seeded.targetId, switched: [], skipped: [] });
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.count({ where: { action: 'orgUnit.container.switch_to_mirrored' } }),
    );
    expect(events).toBe(2);
  });

  it('names a unit it cannot convert and leaves its typed DN in force', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const seeded = await seedHandTypedTree();
    // A mirrored row of another unit already holds IT's derived DN.
    await withTenant(ctx.tenantId, async (tx) => {
      const squatter = await tx.orgUnit.create({ data: { tenantId: ctx.tenantId, name: 'Squatter' } });
      await tx.orgUnitContainer.create({
        data: {
          tenantId: ctx.tenantId,
          orgUnitId: squatter.id,
          targetSystemId: seeded.targetId,
          dn: `OU=IT,OU=Corp,${BASE_DN}`,
          state: 'live',
          source: 'mirrored',
        },
      });
    });

    const res = await post(url(seeded.targetId), cookie, {});

    expect(res.statusCode).toBe(200);
    expect(res.json().switched.map((s: { unitName: string }) => s.unitName)).toEqual(['Corp']);
    expect(res.json().skipped).toEqual([
      expect.objectContaining({ orgUnitId: seeded.itId, unitName: 'IT', dn: `OU=IT,${BASE_DN}`, reason: 'dn_taken' }),
    ]);
  });

  it('refuses a target that does not mirror, converting nothing', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const seeded = await seedHandTypedTree();
    await withTenant(ctx.tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: seeded.targetId }, data: { mirrorOrgUnits: false } }),
    );

    const res = await post(url(seeded.targetId), cookie, {});

    expect(res.statusCode).toBe(409);
    expect(res.json().type).toMatch(/not-mirroring/);
    const manual = await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnitContainer.count({ where: { targetSystemId: seeded.targetId, source: 'manual' } }),
    );
    expect(manual).toBe(3);
  });

  it('answers 404 for an unknown target', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const res = await post(url('00000000-0000-4000-8000-000000000000'), cookie, {});
    expect(res.statusCode).toBe(404);
  });

  it('needs provision.manage, as the single switch does', async () => {
    await seedAdmin(ALL.filter((p) => p !== PERMISSIONS.PROVISION_MANAGE));
    const cookie = await adminCookie();
    const seeded = await seedHandTypedTree();

    const res = await post(url(seeded.targetId), cookie, {});

    expect(res.statusCode).toBe(403);
    const manual = await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnitContainer.count({ where: { targetSystemId: seeded.targetId, source: 'manual' } }),
    );
    expect(manual).toBe(3);
  });

  it('needs an elevated (administrative) session, as the single switch does', async () => {
    await seedAdmin(ALL);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'admin', password: PASSWORD },
    });
    const plain = `syntra_session=${login.cookies.find((c) => c.name === 'syntra_session')!.value}`;
    const seeded = await seedHandTypedTree();

    const res = await post(url(seeded.targetId), plain, {});

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toMatch(/admin-session-required/);
  });
});

describe('deleting a unit people are assigned to', () => {
  it('refuses, and names the people', async () => {
    // `Person.orgUnitId` is ON DELETE SET NULL, so this delete would SUCCEED
    // and silently unassign everybody -- and the next provisioning run would
    // then propose a container move for every one of their accounts back to
    // whatever the template renders. A mass container move from one button,
    // arriving from a direction the provisioning guard cannot see, because the
    // plan is a correct plan for the state the database is now in.
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId } = await seedUnitAndTarget();
    await withTenant(ctx.tenantId, (tx) =>
      tx.person.create({
        data: {
          tenantId: ctx.tenantId,
          givenName: 'Anna',
          familyName: 'Novak',
          orgUnitId,
        },
      }),
    );

    const res = await del(`/api/admin/org-units/${orgUnitId}`, cookie);

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/1 assigned person/);

    // Still there, and still holding them.
    const person = await withTenant(ctx.tenantId, (tx) => tx.person.findFirst());
    expect(person?.orgUnitId).toBe(orgUnitId);
  });

  it('still deletes a unit nobody is assigned to', async () => {
    await seedAdmin(ALL);
    const cookie = await adminCookie();
    const { orgUnitId } = await seedUnitAndTarget();

    const res = await del(`/api/admin/org-units/${orgUnitId}`, cookie);

    expect(res.statusCode).toBe(204);
  });
});
