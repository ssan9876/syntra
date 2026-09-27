import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  OWNER_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createBuiltInRoles,
  createRole,
  createUser,
  hashPassword,
  issueApiToken,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

/**
 * `DELETE /api/admin/persons/:id`, and the Data deletion role behind it:
 * only an Owner assigns it, and only its holders may delete.
 */

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let ownerId: string;
let adminId: string;
let dataDeletionRoleId: string;
let personId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const REASON = 'Created twice by the CSV import';

const db = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx.tenantId, fn);

async function elevated(login: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  const portal = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  return up.cookies.find((c) => c.name === 'syntra_session')!.value;
}

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string, payload?: object) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
    ...(payload === undefined ? {} : { payload }),
  });

const del = (cookie: string, body: object = { reason: REASON, confirm: 'Anna Novak' }, id = personId) =>
  call('DELETE', `/api/admin/persons/${id}`, cookie, body);

const grantDataDeletion = (cookie: string, userId: string) =>
  call('POST', `/api/admin/roles/${dataDeletionRoleId}/assignments`, cookie, { userId });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  await db(async (tx) => {
    const { owner, dataDeletion } = await createBuiltInRoles(tx);
    dataDeletionRoleId = dataDeletion.id;

    const ownerUser = await createUser(tx, { login: 'owner', email: 'owner@acme.test', displayName: 'Ada' });
    await setPasswordHash(tx, ownerUser.id, PASSWORD_HASH);
    await assignRole(tx, ownerUser.id, owner.id);
    ownerId = ownerUser.id;

    // Everything an Owner has, without being one.
    const admin = await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Bo' });
    await setPasswordHash(tx, admin.id, PASSWORD_HASH);
    await assignRole(tx, admin.id, (await createRole(tx, 'Everything', OWNER_PERMISSIONS)).id);
    adminId = admin.id;

    const person = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak', status: 'inactive' },
    });
    personId = person.id;
    await tx.contract.create({ data: { tenantId: ctx.tenantId, personId, startDate: new Date() } });
  });
});

describe('the Data deletion role', () => {
  it('is listed as built in, with the viewer told whether they are an Owner', async () => {
    const owner = await elevated('owner');
    const body = (await call('GET', '/api/admin/roles', owner)).json() as {
      restricted: string[];
      viewerIsOwner: boolean;
      roles: { name: string; systemKey: string | null; builtIn: boolean; permissions: string[] }[];
    };
    expect(body.restricted).toEqual([PERMISSIONS.PERSON_PURGE]);
    expect(body.viewerIsOwner).toBe(true);
    expect(body.roles.find((r) => r.systemKey === 'data-deletion')).toMatchObject({
      name: 'Data deletion',
      builtIn: true,
      permissions: [PERMISSIONS.PERSON_PURGE],
    });

    const admin = await elevated('admin');
    expect(((await call('GET', '/api/admin/roles', admin)).json() as { viewerIsOwner: boolean }).viewerIsOwner).toBe(false);
  });

  it('is assigned by an Owner, to themselves too, and audited', async () => {
    const owner = await elevated('owner');
    expect((await grantDataDeletion(owner, ownerId)).statusCode).toBe(204);
    const event = await db((tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'rbac.role_assigned', outcome: 'success' } }),
    );
    expect(event).toMatchObject({ targetId: ownerId, payload: expect.objectContaining({ roleId: dataDeletionRoleId }) });

    expect(
      (await call('DELETE', `/api/admin/roles/${dataDeletionRoleId}/assignments/${ownerId}`, owner)).statusCode,
    ).toBe(204);
  });

  it('refuses anybody else with 403, for granting and removing, and audits the refusal', async () => {
    const admin = await elevated('admin');
    const res = await grantDataDeletion(admin, adminId);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toBe('Only an Owner can grant or remove the "Data deletion" role.');
    expect(await db((tx) => tx.roleAssignment.count({ where: { roleId: dataDeletionRoleId } }))).toBe(0);
    const refusal = await db((tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'rbac.role_assigned', outcome: 'failure' } }),
    );
    expect(refusal.payload).toMatchObject({ reason: 'owner_only' });

    await db((tx) => assignRole(tx, ownerId, dataDeletionRoleId));
    const removal = await call('DELETE', `/api/admin/roles/${dataDeletionRoleId}/assignments/${ownerId}`, admin);
    expect(removal.statusCode).toBe(403);
    expect(await db((tx) => tx.roleAssignment.count({ where: { roleId: dataDeletionRoleId } }))).toBe(1);
  });

  it('refuses person.purge on any other role, and any edit to its permissions', async () => {
    const owner = await elevated('owner');
    const created = await call('POST', '/api/admin/roles', owner, {
      name: 'Purgers',
      permissions: [PERMISSIONS.PERSON_PURGE],
    });
    expect(created.statusCode).toBe(422);

    const widened = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/admin/roles/${dataDeletionRoleId}`,
      headers: { host: ctx.host, cookie: `syntra_session=${owner}` },
      payload: { permissions: [PERMISSIONS.PERSON_PURGE, PERMISSIONS.AUDIT_READ] },
    });
    expect(widened.statusCode).toBe(409);

    const deleted = await call('DELETE', `/api/admin/roles/${dataDeletionRoleId}`, owner);
    expect(deleted.statusCode).toBe(409);
  });
});

describe('DELETE /api/admin/persons/:id', () => {
  const holder = async () => {
    await db((tx) => assignRole(tx, adminId, dataDeletionRoleId));
    return elevated('admin');
  };

  it('refuses an Owner who does not hold Data deletion', async () => {
    const owner = await elevated('owner');
    expect((await del(owner)).statusCode).toBe(403);
    expect(await db((tx) => tx.person.count())).toBe(1);
  });

  it('deletes an inactive person for a holder, with 204 and one audit event', async () => {
    const cookie = await holder();
    const res = await del(cookie);
    expect(res.statusCode).toBe(204);
    expect(await db((tx) => tx.person.count())).toBe(0);
    expect(await db((tx) => tx.contract.count())).toBe(0);

    const event = await db((tx) => tx.auditEvent.findFirstOrThrow({ where: { action: 'person.purged', outcome: 'success' } }));
    expect(event.payload).toMatchObject({ reason: REASON, counts: expect.objectContaining({ contracts: 1 }) });
    expect(JSON.stringify(event.payload)).not.toContain('Novak');

    expect((await del(cookie)).statusCode).toBe(404);
  });

  it('refuses an active person with 409', async () => {
    const cookie = await holder();
    await db((tx) => tx.person.update({ where: { id: personId }, data: { status: 'active' } }));
    const res = await del(cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('Anna Novak is active. Deactivate them, then delete.');
    expect(await db((tx) => tx.person.count())).toBe(1);
  });

  it('refuses a name that does not match, and a short reason', async () => {
    const cookie = await holder();
    expect((await del(cookie, { reason: REASON, confirm: 'anna novak' })).statusCode).toBe(400);
    expect((await del(cookie, { reason: 'mistake', confirm: 'Anna Novak' })).statusCode).toBe(400);
    expect(await db((tx) => tx.person.count())).toBe(1);
  });

  it('demands a fresh elevation', async () => {
    const cookie = await holder();
    await db((tx) =>
      tx.session.updateMany({ where: { scope: 'admin' }, data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) } }),
    );
    const res = await del(cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toMatch(/step-up-required$/);
    expect(await db((tx) => tx.person.count())).toBe(1);
  });

  it('refuses a machine token, whatever it holds', async () => {
    await db((tx) => assignRole(tx, adminId, dataDeletionRoleId));
    const token = await db(
      async (tx) => (await issueApiToken(tx, { userId: adminId, name: 't', scopes: [], expiresAt: null, createdBy: null })).token,
    );
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/persons/${personId}`,
      headers: { host: ctx.host, authorization: `Bearer ${token}` },
      payload: { reason: REASON, confirm: 'Anna Novak' },
    });
    expect(res.statusCode).toBe(403);
    expect(await db((tx) => tx.person.count())).toBe(1);
  });
});
