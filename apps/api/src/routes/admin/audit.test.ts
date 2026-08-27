import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { asDatabaseSuperuser } from '@syntra/db/src/test-support.js';
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


async function adminCookie(permissions: Permission[]) {
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'a@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
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

  /**
   * The log behind one account's or one person's screen.
   *
   * Filtering in the browser was the alternative and is not equivalent: a page
   * of recent events narrowed client-side silently omits everything older than
   * the window, so a quiet account reads as an account nothing ever happened
   * to.
   */
  it('narrows to one subject, in both directions', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);

    // The admin created above is the actor on its own sign-in events, so it
    // is a subject with real history rather than a fixture id.
    const all = await get('/api/admin/audit?limit=200', cookie);
    const actorId = all
      .json()
      .events.find((e: { actorUserId: string | null }) => e.actorUserId)
      .actorUserId as string;

    const res = await get(`/api/admin/audit?subject=${actorId}`, cookie);
    expect(res.statusCode).toBe(200);

    const { events } = res.json();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect([event.actorUserId, event.targetId]).toContain(actorId);
    }
  });

  it('takes several subjects at once', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);
    const all = await get('/api/admin/audit?limit=200', cookie);
    const actorId = all
      .json()
      .events.find((e: { actorUserId: string | null }) => e.actorUserId)
      .actorUserId as string;
    const absent = '99999999-9999-4999-8999-999999999999';

    const one = await get(`/api/admin/audit?subject=${actorId}`, cookie);
    const two = await get(
      `/api/admin/audit?subject=${actorId}&subject=${absent}`,
      cookie,
    );

    expect(two.json().events).toHaveLength(one.json().events.length);
  });

  it('answers a subject with no history with an empty log, not the whole one', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);

    const res = await get(
      '/api/admin/audit?subject=99999999-9999-4999-8999-999999999999',
      cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
  });

  /**
   * `targetId` and `actorUserId` are `uuid` columns, so a subject that is not
   * one is a database error rather than an empty result. Rejected at the edge,
   * where it can be answered as a bad request.
   */
  it('rejects a subject that is not a uuid', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);

    const res = await get('/api/admin/audit?subject=not-a-uuid', cookie);
    expect(res.statusCode).toBe(400);
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
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
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
