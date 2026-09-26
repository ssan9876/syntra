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
        data: { tenantId: ctx.tenantId, name: 'Contoso Entra', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/attention' },
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
      targetName: 'Contoso Entra',
      status: 'blocked',
      requiresConfirmation: true,
      plannedChanges: 1,
      href: `/admin/targets/${targetId}/runs/${runId}`,
    });
    expect(body.provisionRuns.items[0].summary).toMatch(/would create 1 of 2 accounts/);

    // Audit-only: nothing about runs, and not an empty list either.
    const other = await read(auditor);
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ total: 0, provisionRuns: null, heldActions: null, lifecycle: null, changeRequests: null });
  });
});

describe('acknowledging and resolving', () => {
  it('acknowledges with a note and names who did, and resolves only with the area\'s permission', async () => {
    ctx = await buildTestApp();
    const { auditor, operator, operatorName } = await withTenant(ctx.tenantId, async (tx) => {
      const sessionFor = async (login: string, displayName: string, permissions: string[]) => {
        const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName });
        const role = await createRole(tx, `${login} role`, permissions as never);
        await assignRole(tx, user.id, role.id);
        const session = await createSession(tx, {
          status: 'allow', userId: user.id, mayElevate: true,
          scope: 'admin', applicationId: null, satisfiedFactor: null,
        }, { ip: null, userAgent: null });
        return `syntra_session=${session.token}`;
      };
      const target = await tx.targetSystem.create({
        data: { tenantId: ctx.tenantId, name: 'Contoso AD', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/incidents' },
      });
      await tx.provisionRun.create({
        data: { tenantId: ctx.tenantId, targetSystemId: target.id, status: 'failed', error: 'connect ETIMEDOUT 10.0.0.5:636' },
      });
      return {
        auditor: await sessionFor('auditor', 'Audit Person', [PERMISSIONS.AUDIT_READ]),
        operator: await sessionFor('operator', 'Ops Person', [PERMISSIONS.AUDIT_READ, PERMISSIONS.PROVISION_MANAGE]),
        operatorName: 'Ops Person',
      };
    });
    const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
      ctx.app.inject({ method, url, headers: { host: ctx.host, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

    const listed = (await call(auditor, 'GET', '/api/admin/incidents')).json().incidents as {
      kind: string; resolvable: boolean; items: { label: string; detail: string }[]; acknowledged: unknown;
    }[];
    const failed = listed.find((i) => i.kind === 'provision_run_failed')!;
    expect(failed.resolvable).toBe(true);
    expect(failed.items[0]).toMatchObject({ label: 'Contoso AD' });
    expect(failed.items[0]!.detail).toContain('ETIMEDOUT');
    expect(failed.acknowledged).toBeNull();

    // Anybody who can read the list can say they are on it.
    const ack = await call(auditor, 'POST', '/api/admin/incidents/provision_run_failed/acknowledge', { note: 'checking the DC' });
    expect(ack.statusCode).toBe(204);

    // Resolving needs the area's management permission.
    const refused = await call(auditor, 'POST', '/api/admin/incidents/provision_run_failed/resolve', {});
    expect(refused.statusCode).toBe(403);

    const resolved = await call(operator, 'POST', '/api/admin/incidents/provision_run_failed/resolve', { note: 'DC back' });
    expect(resolved.statusCode).toBe(204);
    const after = (await call(auditor, 'GET', '/api/admin/incidents')).json().incidents as { kind: string }[];
    expect(after.map((i) => i.kind)).not.toContain('provision_run_failed');

    // A condition cannot be resolved away.
    const condition = await call(operator, 'POST', '/api/admin/incidents/target_runs_skipped/resolve', {});
    expect(condition.statusCode).toBe(409);
    expect(condition.json().type).toContain('incident-not-resolvable');

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'incident.' } }, orderBy: { sequence: 'asc' } }),
    );
    expect(events.map((e) => e.action)).toEqual(['incident.acknowledged', 'incident.resolved']);
    expect(operatorName).toBe('Ops Person');
  });

  it('shows who acknowledged, by name', async () => {
    ctx = await buildTestApp();
    const cookie = await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, { login: 'auditor', email: 'audit@acme.test', displayName: 'Audit Person' });
      const role = await createRole(tx, 'Auditor', [PERMISSIONS.AUDIT_READ]);
      await assignRole(tx, user.id, role.id);
      const target = await tx.targetSystem.create({
        data: { tenantId: ctx.tenantId, name: 'Contoso AD', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/incidents-2' },
      });
      await tx.provisionRun.create({ data: { tenantId: ctx.tenantId, targetSystemId: target.id, status: 'failed' } });
      const session = await createSession(tx, {
        status: 'allow', userId: user.id, mayElevate: true,
        scope: 'admin', applicationId: null, satisfiedFactor: null,
      }, { ip: null, userAgent: null });
      return `syntra_session=${session.token}`;
    });
    await ctx.app.inject({
      method: 'POST', url: '/api/admin/incidents/provision_run_failed/acknowledge',
      headers: { host: ctx.host, cookie }, payload: {},
    });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/admin/incidents', headers: { host: ctx.host, cookie } });
    const failed = (list.json().incidents as { kind: string; acknowledged: { by: string } | null }[])
      .find((i) => i.kind === 'provision_run_failed')!;
    expect(failed.acknowledged?.by).toBe('Audit Person');
  });
});
