import { afterEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { assignRole, createRole, createSession, createUser, PERMISSIONS } from '@syntra/core';
import { buildTestApp, createFakeScheduler } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
afterEach(async () => { await ctx?.app.close(); });

describe('scheduler incident', () => {
  it('requires authorization and clears automatically after recovery', async () => {
    let running = false;
    const scheduler = createFakeScheduler();
    ctx = await buildTestApp({ scheduler: () => running ? scheduler : null });
    const cookie = await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, { login: 'auditor', email: 'audit@acme.test', displayName: 'Auditor' });
      const role = await createRole(tx, 'Auditor', [PERMISSIONS.AUDIT_READ]);
      await assignRole(tx, user.id, role.id);
      const session = await createSession(tx, {
        status: 'allow', userId: user.id, mayElevate: true,
        scope: 'admin', applicationId: null, satisfiedFactor: null,
      }, { ip: null, userAgent: null });
      return `syntra_session=${session.token}`;
    });
    const read = (authenticated: boolean) => ctx.app.inject({
      method: 'GET', url: '/api/admin/incidents',
      headers: { host: ctx.host, ...(authenticated ? { cookie } : {}) },
    });
    expect((await read(false)).statusCode).toBe(401);
    const failed = await read(true);
    expect(failed.statusCode).toBe(200);
    expect(failed.json().incidents).toContainEqual(expect.objectContaining({
      kind: 'scheduler_unavailable', severity: 'critical',
    }));
    running = true;
    expect((await read(true)).json().incidents).not.toContainEqual(expect.objectContaining({
      kind: 'scheduler_unavailable',
    }));
  });
});
