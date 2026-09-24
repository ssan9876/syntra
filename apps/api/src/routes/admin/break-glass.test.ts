import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const REASON = 'Every administrator security key was lost in the office fire';

let glassId: string; let aliceId: string;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await withTenant(ctx.tenantId, async (tx) => {
    const owner = await createRole(tx, 'Owner', [PERMISSIONS.TENANT_MANAGE, PERMISSIONS.RBAC_MANAGE]);
    for (const login of ['alice', 'bob', 'glass']) {
      const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
      await assignRole(tx, user.id, owner.id);
      if (login === 'glass') glassId = user.id;
      if (login === 'alice') aliceId = user.id;
    }
  });
});

async function portalCookie(login: string) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: ctx.host }, payload: { login, password: PASSWORD } });
  return `syntra_session=${res.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

async function elevate(login: string) {
  const portal = await portalCookie(login);
  const up = await ctx.app.inject({ method: 'POST', url: '/api/auth/elevate', headers: { host: ctx.host, cookie: portal }, payload: { password: PASSWORD } });
  const cookie = up.cookies.find((c) => c.name === 'syntra_session');
  return { status: up.statusCode, cookie: cookie ? `syntra_session=${cookie.value}` : null };
}

const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { host: ctx.host, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

const activate = (credential: string) => ctx.app.inject({
  method: 'POST', url: '/api/auth/break-glass/activate', headers: { host: ctx.host },
  payload: { login: 'glass', credential, reason: REASON, durationMinutes: 30 },
});

describe('break-glass end to end', () => {
  it('designates, announces, activates under four eyes, bypasses the key requirement only while active, and is reviewed by somebody else', async () => {
    const alice = (await elevate('alice')).cookie!;

    // Nobody designates themselves.
    const self = await call(alice, 'POST', '/api/admin/break-glass/accounts', { userId: aliceId });
    expect(self.statusCode).toBe(403);

    const designated = await call(alice, 'POST', '/api/admin/break-glass/accounts', { userId: glassId });
    expect(designated.statusCode).toBe(201);
    expect(designated.headers['cache-control']).toBe('no-store');
    const { credential } = designated.json();
    expect(credential).toMatch(/^syntra_bg_/);

    // Outside an activation the account cannot reach the console at all.
    expect((await elevate('glass')).status).toBe(401);

    // A wrong credential is one generic refusal.
    const wrong = await activate('syntra_bg_not-it');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().type).toContain('invalid-credentials');

    const requested = await activate(credential);
    expect(requested.statusCode).toBe(202);
    const { activationId } = requested.json();
    // Every tenant.manage holder is mailed at once, and the credential is in none of them.
    expect(ctx.mail.sent.map((m) => m.to).sort()).toEqual(['alice@acme.test', 'bob@acme.test', 'glass@acme.test']);
    expect(ctx.mail.sent.every((m) => !m.text.includes(credential))).toBe(true);

    // Still pending: refused, and the banner says so to every administrator.
    expect((await elevate('glass')).status).toBe(401);
    const banner = await call(alice, 'GET', '/api/admin/break-glass/status');
    expect(banner.json().activations).toEqual([expect.objectContaining({ id: activationId, status: 'pending' })]);

    // Only somebody other than the emergency account approves early.
    const bob = (await elevate('bob')).cookie!;
    const approved = await call(bob, 'POST', `/api/admin/break-glass/activations/${activationId}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().activation).toMatchObject({ status: 'active', activatedBy: 'approval' });
    expect(ctx.mail.sent.filter((m) => m.subject.includes('is active'))).toHaveLength(3);

    // Now require a security key for the console. Nobody here holds one;
    // only the activated emergency account gets in, through authorize().
    await prisma.tenant.update({ where: { id: ctx.tenantId }, data: { primaryDomain: ctx.host, adminWebauthnRequired: true } });
    expect((await elevate('alice')).status).toBe(403);
    const glass = await elevate('glass');
    expect(glass.status).toBe(200);
    const status = await call(glass.cookie!, 'GET', '/api/admin/break-glass/status');
    expect(status.json()).toMatchObject({ viewerActivationId: activationId, activations: [expect.objectContaining({ status: 'active' })] });

    // The emergency account ends its own access; its session stops with it.
    expect((await call(glass.cookie!, 'POST', `/api/admin/break-glass/activations/${activationId}/end`)).statusCode).toBe(200);
    expect((await call(glass.cookie!, 'GET', '/api/admin/break-glass/status')).statusCode).toBe(401);

    // The review: somebody else, stepped up, with findings.
    await prisma.tenant.update({ where: { id: ctx.tenantId }, data: { adminWebauthnRequired: false } });
    const reviewer = (await elevate('bob')).cookie!;
    const short = await call(reviewer, 'POST', `/api/admin/break-glass/activations/${activationId}/review`, { notes: 'ok' });
    expect(short.statusCode).toBe(400);
    const reviewed = await call(reviewer, 'POST', `/api/admin/break-glass/activations/${activationId}/review`, {
      notes: 'Re-registered keys for alice and bob; no other changes in the window',
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().activation).toMatchObject({ reviewStatus: 'completed' });

    const actions = await withTenant(ctx.tenantId, async (tx) =>
      (await tx.auditEvent.findMany({ where: { action: { startsWith: 'break_glass.' } }, orderBy: { sequence: 'asc' } })).map((e) => e.action));
    expect(actions).toEqual([
      'break_glass.account_designated',
      'break_glass.activation_refused',
      'break_glass.activation_requested',
      'break_glass.activated',
      'break_glass.ended',
      'break_glass.reviewed',
    ]);
    // Security events fan out to subscribed webhooks through the audit log.
    expect(await withTenant(ctx.tenantId, (tx) => tx.auditEvent.count({ where: { action: 'auth.break_glass_refused' } }))).toBe(2);
  });

  it('lets any administrator cancel a pending activation', async () => {
    const alice = (await elevate('alice')).cookie!;
    const { credential } = (await call(alice, 'POST', '/api/admin/break-glass/accounts', { userId: glassId })).json();
    const { activationId } = (await activate(credential)).json();
    const cancelled = await call(alice, 'POST', `/api/admin/break-glass/activations/${activationId}/end`);
    expect(cancelled.json().activation.status).toBe('cancelled');
    expect((await call(alice, 'GET', '/api/admin/break-glass')).json()).toMatchObject({
      activationDelayMinutes: 60,
      accounts: [expect.objectContaining({ userId: glassId, login: 'glass' })],
    });
  });
});
