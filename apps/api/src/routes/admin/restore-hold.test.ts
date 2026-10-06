import { afterEach, describe, expect, it } from 'vitest';
import { createRestoreHold, withTenant } from '@syntra/db';
import { assignRole, createRole, createSession, createUser, PERMISSIONS, type Permission } from '@syntra/core';
import { buildTestApp, createFakeScheduler } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
afterEach(async () => { await ctx?.app.close(); });

async function cookieFor(login: string, permissions: Permission[]): Promise<string> {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id);
    const session = await createSession(tx, {
      status: 'allow', userId: user.id, mayElevate: true,
      scope: 'admin', applicationId: null, satisfiedFactor: null,
    }, { ip: null, userAgent: null });
    return `syntra_session=${session.token}`;
  });
}

const call = (method: 'GET' | 'POST', url: string, cookie: string) =>
  ctx.app.inject({ method, url, headers: { host: ctx.host, cookie } });

describe('restore hold routes', () => {
  it('shows a hold to every administrator and lets only deployment.manage resume it', async () => {
    ctx = await buildTestApp({ scheduler: () => createFakeScheduler() });
    const reader = await cookieFor('reader', [PERMISSIONS.DIRECTORY_READ]);
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE]);

    expect((await call('GET', '/api/admin/restore-hold', reader)).json()).toEqual({ hold: null, mayResume: false });

    await createRestoreHold({
      backupName: 'syntra-20261005T020000Z',
      backupTakenAt: new Date('2026-10-05T02:00:00Z'),
      backupVersion: '1.20.0',
      restoredAt: new Date('2026-10-05T14:12:00Z'),
    });

    const seen = await call('GET', '/api/admin/restore-hold', reader);
    expect(seen.json()).toEqual({
      hold: {
        backupName: 'syntra-20261005T020000Z',
        backupTakenAt: '2026-10-05T02:00:00.000Z',
        backupVersion: '1.20.0',
        restoredAt: '2026-10-05T14:12:00.000Z',
      },
      mayResume: false,
    });
    expect((await call('GET', '/api/admin/restore-hold', operator)).json().mayResume).toBe(true);

    expect((await call('POST', '/api/admin/restore-hold/resume', reader)).statusCode).toBe(403);
    const resumed = await call('POST', '/api/admin/restore-hold/resume', operator);
    expect(resumed.statusCode).toBe(200);
    expect((await call('GET', '/api/admin/restore-hold', operator)).json().hold).toBeNull();

    const again = await call('POST', '/api/admin/restore-hold/resume', operator);
    expect(again.statusCode).toBe(409);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'deployment.restore_resumed' } }));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ backupName: 'syntra-20261005T020000Z' });
  });
});
