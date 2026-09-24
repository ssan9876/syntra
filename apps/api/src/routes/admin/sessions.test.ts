import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createSession,
  createUser,
  hashPassword,
  issueApiToken,
  setPasswordHash,
  type Permission,
  type SessionAllowance,
  type SessionScope,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

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
    if (permissions.length > 0) {
      const role = await createRole(tx, 'Custom', permissions);
      await assignRole(tx, user.id, role.id);
    }
    return user;
  });
}

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

const allowed = (userId: string, scope: SessionScope): SessionAllowance => ({
  status: 'allow',
  userId,
  mayElevate: false,
  applicationId: null,
  scope,
  satisfiedFactor: null,
});

/** A second account with `count` live sessions, none of them the caller's. */
async function seedTargetWithSessions(count: number) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    for (let i = 0; i < count; i += 1) {
      await createSession(tx, allowed(user.id, 'portal'), {
        ip: `198.51.100.${i + 1}`,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/141.0',
      });
    }
    return user;
  });
}

const listSessions = (userId: string, cookie: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/admin/users/${userId}/sessions`,
    headers: { host: ctx.host, cookie },
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('listing somebody\'s sessions', () => {
  it('shows the live ones with where they came from', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(2);

    const res = await listSessions(target.id, cookie);

    expect(res.statusCode).toBe(200);
    const { sessions } = res.json();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].ip).toMatch(/^198\.51\.100\./);
    expect(sessions[0].userAgent).toContain('Firefox');
  });

  it('never hands back the token hash', async () => {
    // The digest is what authenticates a session. A list is read by somebody
    // who is entitled to END these sessions, not to HOLD them.
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(1);

    const res = await listSessions(target.id, cookie);

    expect(res.body).not.toContain('tokenHash');
    expect(res.json().sessions[0]).not.toHaveProperty('tokenHash');
  });
});

describe('revoking one session', () => {
  it('ends it and records who did it and why', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(2);
    const victim = (await listSessions(target.id, cookie)).json().sessions[0].id;

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${target.id}/sessions/${victim}`,
      headers: { host: ctx.host, cookie },
    });

    expect(res.statusCode).toBe(204);
    expect((await listSessions(target.id, cookie)).json().sessions).toHaveLength(1);

    const event = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { action: 'session.revoked' },
        orderBy: { sequence: 'desc' },
      }),
    );
    expect(event).not.toBeNull();
    expect((event!.payload as Record<string, unknown>).trigger).toBe('admin');
    expect(event!.targetId).toBe(target.id);
  });

  it('answers 404 for a session that is not this user\'s', async () => {
    // A session id read from one account's list must not end another's.
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(1);
    const admin = await withTenant(ctx.tenantId, (tx) =>
      tx.user.findFirstOrThrow({ where: { login: 'admin' } }),
    );
    const someoneElses = (await listSessions(admin.id, cookie)).json().sessions[0].id;

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${target.id}/sessions/${someoneElses}`,
      headers: { host: ctx.host, cookie },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('revoking every session', () => {
  it('reports how many it ended', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(3);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${target.id}/sessions/revoke`,
      headers: { host: ctx.host, cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionsRevoked: 3 });
    expect((await listSessions(target.id, cookie)).json().sessions).toEqual([]);
  });
});

describe('who may do this', () => {
  it('refuses a reader trying to revoke', async () => {
    // Reading the list and ending a session are different authorities.
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(1);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${target.id}/sessions/revoke`,
      headers: { host: ctx.host, cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses a portal session holding every permission', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('portal');
    const target = await seedTargetWithSessions(1);

    const res = await listSessions(target.id, cookie);

    expect(res.statusCode).toBe(403);
  });
});

describe('revoking sessions across the tenant', () => {
  const revokeAll = (
    cookie: string,
    payload: Record<string, unknown> = { reason: 'suspected credential theft' },
  ) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/admin/sessions/revoke',
      headers: { host: ctx.host, cookie },
      payload,
    });

  /** Ages the caller's console session past the step-up window. */
  const ageAdminSessions = (minutes: number) =>
    withTenant(ctx.tenantId, (tx) =>
      tx.session.updateMany({
        where: { scope: 'admin' },
        data: { createdAt: new Date(Date.now() - minutes * 60 * 1000) },
      }),
    );

  it('ends everybody else and keeps the session that asked', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE, PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(2);

    const res = await revokeAll(cookie);

    expect(res.statusCode).toBe(200);
    // The target's two, and the admin's own portal session from sign-in.
    expect(res.json()).toMatchObject({ usersAffected: 2, sessionsRevoked: 3 });
    // Still signed in: the caller's own console session was spared.
    const after = await listSessions(target.id, cookie);
    expect(after.statusCode).toBe(200);
    expect(after.json().sessions).toEqual([]);

    const summary = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'session.mass_revoked' } }),
    );
    expect(summary.payload).toMatchObject({
      scope: 'all',
      reason: 'suspected credential theft',
      keptCurrentSession: true,
    });
  });

  it('can end the caller too when asked', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE, PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');

    const res = await revokeAll(cookie, {
      reason: 'suspected credential theft',
      keepCurrentSession: false,
    });
    expect(res.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/tenant',
      headers: { host: ctx.host, cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('can be narrowed to console sessions', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE, PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(2);
    await withTenant(ctx.tenantId, (tx) =>
      createSession(tx, allowed(target.id, 'admin'), { ip: null, userAgent: null }),
    );

    const res = await revokeAll(cookie, {
      reason: 'administrator credential leaked',
      scope: 'admin',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionsRevoked: 1 });
    const left = (await listSessions(target.id, cookie)).json().sessions;
    expect(left.map((s: { scope: string }) => s.scope)).toEqual(['portal', 'portal']);
  });

  it('demands a fresh elevation', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE, PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const target = await seedTargetWithSessions(1);
    await ageAdminSessions(11);

    const res = await revokeAll(cookie);

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toMatch(/step-up-required$/);
    expect((await listSessions(target.id, cookie)).json().sessions).toHaveLength(1);
  });

  it('refuses without the tenant permission, whatever else is held', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');

    expect((await revokeAll(cookie)).statusCode).toBe(403);
  });

  it('refuses a reason too short to mean anything', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await authCookie('admin');

    expect((await revokeAll(cookie, { reason: 'x' })).statusCode).toBe(400);
  });

  it('refuses a bearer token even with the permission', async () => {
    const admin = await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const { token } = await withTenant(ctx.tenantId, (tx) =>
      issueApiToken(tx, {
        userId: admin.id,
        name: 'automation',
        scopes: [],
        expiresAt: null,
        createdBy: null,
      }),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/sessions/revoke',
      headers: { host: ctx.host, authorization: `Bearer ${token}` },
      payload: { reason: 'suspected credential theft' },
    });

    expect(res.statusCode).toBe(403);
  });
});
