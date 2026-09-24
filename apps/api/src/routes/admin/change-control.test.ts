import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hasPermission,
  hashPassword,
  issueApiToken,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const REASON = 'On-call rota change agreed in the ops review';

let requesterId: string; let approverId: string; let serviceId: string; let tenantAdminRoleId: string;

async function seed() {
  await withTenant(ctx.tenantId, async (tx) => {
    const owner = await createRole(tx, 'Owner', [PERMISSIONS.RBAC_MANAGE, PERMISSIONS.TENANT_MANAGE, PERMISSIONS.TOKEN_MANAGE]);
    for (const login of ['requester', 'approver']) {
      const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
      await assignRole(tx, user.id, owner.id);
      if (login === 'requester') requesterId = user.id; else approverId = user.id;
    }
    serviceId = (await createUser(tx, { login: 'svc', email: 'svc@acme.test', displayName: 'Service' })).id;
    tenantAdminRoleId = (await createRole(tx, 'Tenant admin', [PERMISSIONS.TENANT_MANAGE])).id;
  });
}

async function adminCookie(login: string) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: ctx.host }, payload: { login, password: PASSWORD } });
  const portal = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST', url: '/api/auth/elevate', headers: { host: ctx.host, cookie: `syntra_session=${portal}` }, payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, reason?: string) =>
  ctx.app.inject({
    method, url,
    headers: { host: ctx.host, cookie, ...(reason ? { 'x-syntra-change-reason': encodeURIComponent(reason) } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const hold = async (cookie: string, classes: string[]) => {
  const res = await call(cookie, 'PUT', '/api/admin/change-control/policy', { classes });
  expect(res.statusCode).toBe(200);
};

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await seed();
});

describe('privileged role grants under separation of duties', () => {
  it('holds the grant, refuses the requester, and applies it on a second administrator\'s approval', async () => {
    const requester = await adminCookie('requester');
    const approver = await adminCookie('approver');
    await hold(requester, ['role_grant']);

    const bare = await call(requester, 'POST', `/api/admin/roles/${tenantAdminRoleId}/assignments`, { userId: serviceId });
    expect(bare.statusCode).toBe(409);
    expect(bare.json()).toMatchObject({ type: expect.stringContaining('change-approval-required'), changeClass: 'role_grant' });

    const held = await call(requester, 'POST', `/api/admin/roles/${tenantAdminRoleId}/assignments`, { userId: serviceId }, REASON);
    expect(held.statusCode).toBe(202);
    const request = held.json().changeRequest;
    expect(request).toMatchObject({ status: 'pending', changeClass: 'role_grant', reason: REASON, requestedByUserId: requesterId });
    expect(await withTenant(ctx.tenantId, (tx) => hasPermission(tx, serviceId, PERMISSIONS.TENANT_MANAGE))).toBe(false);

    const own = await call(requester, 'POST', `/api/admin/change-control/requests/${request.id}/approve`, {});
    expect(own.statusCode).toBe(403);
    expect(own.json().type).toContain('four-eyes-required');

    const approved = await call(approver, 'POST', `/api/admin/change-control/requests/${request.id}/approve`, { note: 'Checked with the ops lead' });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().changeRequest).toMatchObject({ status: 'applied', decidedByUserId: approverId, decisionNote: 'Checked with the ops lead' });
    expect(await withTenant(ctx.tenantId, (tx) => hasPermission(tx, serviceId, PERMISSIONS.TENANT_MANAGE))).toBe(true);

    const queue = await call(approver, 'GET', '/api/admin/change-control');
    expect(queue.json()).toMatchObject({ classes: ['role_grant'], requests: [expect.objectContaining({ id: request.id, status: 'applied' })] });
  });

  it('lets a harmless role through, and holds widening a role to a privileged permission', async () => {
    const requester = await adminCookie('requester');
    await hold(requester, ['role_grant']);
    const readers = await withTenant(ctx.tenantId, (tx) => createRole(tx, 'Readers', [PERMISSIONS.DIRECTORY_READ]));
    expect((await call(requester, 'POST', `/api/admin/roles/${readers.id}/assignments`, { userId: serviceId })).statusCode).toBe(204);
    const widen = await call(requester, 'PATCH', `/api/admin/roles/${readers.id}`, { permissions: [PERMISSIONS.DIRECTORY_READ, PERMISSIONS.RBAC_MANAGE] }, REASON);
    expect(widen.statusCode).toBe(202);
    expect(widen.json().changeRequest.summary).toContain('rbac.manage');
    expect(await withTenant(ctx.tenantId, (tx) => hasPermission(tx, serviceId, PERMISSIONS.RBAC_MANAGE))).toBe(false);
    // Renaming is not a grant.
    expect((await call(requester, 'PATCH', `/api/admin/roles/${readers.id}`, { name: 'Directory readers' })).statusCode).toBe(204);
  });

  it('refuses a stale request once the role it grants has changed, and demands a fresh step-up', async () => {
    const requester = await adminCookie('requester');
    const approver = await adminCookie('approver');
    await hold(requester, ['role_grant']);
    const held = await call(requester, 'POST', `/api/admin/roles/${tenantAdminRoleId}/assignments`, { userId: serviceId }, REASON);
    const id = held.json().changeRequest.id;

    await withTenant(ctx.tenantId, (tx) => tx.session.updateMany({
      where: { userId: approverId, scope: 'admin' }, data: { createdAt: new Date(Date.now() - 11 * 60_000) },
    }));
    const tooOld = await call(approver, 'POST', `/api/admin/change-control/requests/${id}/approve`, {});
    expect(tooOld.statusCode).toBe(403);
    expect(tooOld.json().type).toContain('step-up-required');

    const fresh = await adminCookie('approver');
    expect((await call(requester, 'PATCH', `/api/admin/roles/${tenantAdminRoleId}`, { name: 'Tenant administrators' })).statusCode).toBe(204);
    const stale = await call(fresh, 'POST', `/api/admin/change-control/requests/${id}/approve`, {});
    expect(stale.statusCode).toBe(409);
    expect(stale.json().type).toContain('stale');
    const row = await withTenant(ctx.tenantId, (tx) => tx.privilegedChangeRequest.findUniqueOrThrow({ where: { id } }));
    expect(row.status).toBe('invalidated');
  });
});

describe('admin-scoped API tokens', () => {
  it('holds minting and hands the secret to the approver once', async () => {
    const requester = await adminCookie('requester');
    const approver = await adminCookie('approver');
    await hold(requester, ['admin_token']);

    const plain = await call(requester, 'POST', `/api/admin/users/${serviceId}/tokens`, { name: 'reader', scopes: [PERMISSIONS.DIRECTORY_READ], expiresAt: null });
    expect(plain.statusCode).toBe(201);

    const held = await call(requester, 'POST', `/api/admin/users/${serviceId}/tokens`, { name: 'admin', scopes: [PERMISSIONS.RBAC_MANAGE], expiresAt: null }, REASON);
    expect(held.statusCode).toBe(202);
    const approved = await call(approver, 'POST', `/api/admin/change-control/requests/${held.json().changeRequest.id}/approve`, {});
    expect(approved.statusCode).toBe(200);
    expect(approved.json().result.token).toMatch(/^syntra_pat_/);
    const stored = approved.json().changeRequest;
    expect(JSON.stringify(stored)).not.toContain(approved.json().result.token);
    expect(stored.result).toEqual({ tokenId: approved.json().result.id });
  });
});

describe('webhook endpoints', () => {
  it('holds creation and applies it with the secret returned to the approver', async () => {
    const requester = await adminCookie('requester');
    const approver = await adminCookie('approver');
    await hold(requester, ['webhook_endpoint']);
    const held = await call(requester, 'POST', '/api/admin/webhooks', { name: 'SIEM', url: 'https://siem.example.test/in', events: ['privileged-access'] }, REASON);
    expect(held.statusCode).toBe(202);
    expect(await withTenant(ctx.tenantId, (tx) => tx.webhookEndpoint.count())).toBe(0);
    const approved = await call(approver, 'POST', `/api/admin/change-control/requests/${held.json().changeRequest.id}/approve`, {});
    expect(approved.statusCode).toBe(200);
    expect(typeof approved.json().result.secret).toBe('string');
    expect(await withTenant(ctx.tenantId, (tx) => tx.webhookEndpoint.count())).toBe(1);
  });
});

describe('authentication policy', () => {
  it('applies tightening directly and holds relaxation', async () => {
    const requester = await adminCookie('requester');
    await hold(requester, ['auth_policy']);
    const tighten = await call(requester, 'PUT', '/api/admin/tenant', { passwordMinLength: 16 });
    expect(tighten.statusCode).toBe(200);
    const relax = await call(requester, 'PUT', '/api/admin/tenant', { passwordMinLength: 12 }, REASON);
    expect(relax.statusCode).toBe(202);
    expect(relax.json().changeRequest.summary).toContain('passwordMinLength');
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
    expect(tenant.passwordMinLength).toBe(16);

    const approver = await adminCookie('approver');
    const approved = await call(approver, 'POST', `/api/admin/change-control/requests/${relax.json().changeRequest.id}/approve`, {});
    expect(approved.statusCode).toBe(200);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } })).passwordMinLength).toBe(12);
  });
});

describe('the policy and the queue', () => {
  it('holds switching a class off, and lets only the requester withdraw', async () => {
    const requester = await adminCookie('requester');
    const approver = await adminCookie('approver');
    await hold(requester, ['role_grant', 'auth_policy']);
    const off = await call(requester, 'PUT', '/api/admin/change-control/policy', { classes: ['auth_policy'] }, REASON);
    expect(off.statusCode).toBe(202);
    const id = off.json().changeRequest.id;
    expect((await call(approver, 'POST', `/api/admin/change-control/requests/${id}/withdraw`, {})).statusCode).toBe(403);
    const withdrawn = await call(requester, 'POST', `/api/admin/change-control/requests/${id}/withdraw`, {});
    expect(withdrawn.json().changeRequest.status).toBe('withdrawn');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } })).privilegedChangeClasses.sort()).toEqual(['auth_policy', 'role_grant']);
  });

  it('refuses machine tokens outright', async () => {
    const { token } = await withTenant(ctx.tenantId, (tx) => issueApiToken(tx, { userId: approverId, name: 't', scopes: [], expiresAt: null, createdBy: null }));
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/change-control', headers: { host: ctx.host, authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toContain('token-not-accepted');
  });
});
