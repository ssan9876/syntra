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

describe('attention summary', () => {
  it('lists runs held for review only to a caller who may read provisioning', async () => {
    ctx = await buildTestApp();
    const { reader, auditor, runId, targetId } = await withTenant(ctx.tenantId, async (tx) => {
      const sessionFor = async (login: string, permissions: string[]) => {
        const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
        const role = await createRole(tx, `${login} role`, permissions as never);
        await assignRole(tx, user.id, role.id);
        const session = await createSession(tx, {
          status: 'allow', userId: user.id, mayElevate: true,
          scope: 'admin', applicationId: null, satisfiedFactor: null,
        }, { ip: null, userAgent: null });
        return `syntra_session=${session.token}`;
      };
      const target = await tx.targetSystem.create({
        data: { tenantId: ctx.tenantId, name: 'ssander.xyz entra', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/attention' },
      });
      const run = await tx.provisionRun.create({
        data: {
          tenantId: ctx.tenantId, targetSystemId: target.id, status: 'blocked', requiresConfirmation: true,
          blockedReason: 'would create 1 of 2 accounts (50.0%), above the 20% threshold', createAccountCount: 1,
        },
      });
      // A finished run is not waiting for anybody.
      await tx.provisionRun.create({ data: { tenantId: ctx.tenantId, targetSystemId: target.id, status: 'applied' } });
      return {
        reader: await sessionFor('operator', [PERMISSIONS.PROVISION_READ]),
        auditor: await sessionFor('auditor', [PERMISSIONS.AUDIT_READ]),
        runId: run.id,
        targetId: target.id,
      };
    });
    const read = (cookie?: string) => ctx.app.inject({
      method: 'GET', url: '/api/admin/attention/summary',
      headers: { host: ctx.host, ...(cookie ? { cookie } : {}) },
    });

    expect((await read()).statusCode).toBe(401);

    const operator = await read(reader);
    expect(operator.statusCode).toBe(200);
    const body = operator.json();
    expect(body.total).toBe(1);
    expect(body.changeRequests).toBeNull();
    expect(body.lifecycle).toMatchObject({ failed: 0, awaitingVerification: 0, items: [] });
    expect(body.provisionRuns.count).toBe(1);
    expect(body.provisionRuns.items[0]).toMatchObject({
      runId,
      targetSystemId: targetId,
      targetName: 'ssander.xyz entra',
      status: 'blocked',
      requiresConfirmation: true,
      plannedChanges: 1,
      href: `/admin/targets/${targetId}/runs/${runId}`,
    });
    expect(body.provisionRuns.items[0].summary).toMatch(/would create 1 of 2 accounts/);

    // Audit-only: nothing about runs, and not an empty list either.
    const other = await read(auditor);
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ total: 0, provisionRuns: null, lifecycle: null, changeRequests: null });
  });
});
