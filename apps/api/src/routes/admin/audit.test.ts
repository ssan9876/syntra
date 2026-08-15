import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { asDatabaseSuperuser } from '@syntra/db/src/test-support.js';
import {
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

async function adminCookie(permissions: Permission[]) {
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'a@acme.test',
      displayName: 'Admin',
    });
    await setPassword(tx, user.id, PASSWORD);
    const role = await createRole(tx, 'R', permissions);
    await assignRole(tx, user.id, role.id);
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;

  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('GET /api/admin/audit', () => {
  it('returns the events written by signing in, newest first', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);

    const res = await get('/api/admin/audit', cookie);
    expect(res.statusCode).toBe(200);

    const { events, chainValid } = res.json();
    expect(chainValid).toBe(true);
    expect(events.length).toBeGreaterThan(1);
    expect(events[0].sequence).toBeGreaterThan(events[1].sequence);
    expect(
      events.some((e: { action: string }) => e.action === 'auth.login'),
    ).toBe(true);
  });

  it('honours the limit', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);

    const res = await get('/api/admin/audit?limit=1', cookie);
    expect(res.json().events).toHaveLength(1);
  });

  it('reports a broken chain instead of serving the events as trustworthy', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);

    // Tamper with database-level privilege, which is the threat the chain
    // exists to detect.
    await asDatabaseSuperuser(
      `ALTER TABLE "AuditEvent" DISABLE RULE audit_no_update`,
    );
    await asDatabaseSuperuser(
      `UPDATE "AuditEvent" SET action = 'tampered'
       WHERE "tenantId" = $1::uuid AND sequence = 1`,
      [ctx.tenantId],
    );
    await asDatabaseSuperuser(
      `ALTER TABLE "AuditEvent" ENABLE RULE audit_no_update`,
    );

    const res = await get('/api/admin/audit', cookie);
    expect(res.json().chainValid).toBe(false);
    expect(res.json().brokenAtSequence).toBe(1);
  });

  it('refuses a caller without audit.read', async () => {
    const cookie = await adminCookie([PERMISSIONS.DIRECTORY_READ]);

    const res = await get('/api/admin/audit', cookie);
    expect(res.statusCode).toBe(403);
  });

  it('refuses a portal session', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'plain',
        email: 'p@acme.test',
        displayName: 'Plain',
      });
      await setPassword(tx, user.id, PASSWORD);
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'plain', password: PASSWORD },
    });
    const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;

    const res = await get('/api/admin/audit', `syntra_session=${token}`);
    expect(res.statusCode).toBe(403);
  });
});
