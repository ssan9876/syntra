import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { assignRole, createRole, createSession, createUser, PERMISSIONS, type Permission } from '@syntra/core';
import { buildTestApp, createFakeScheduler } from '../../test-support.js';

/*
 * The operations routes (backlog #57, #63, #64): job health and its repairs,
 * tenant and deployment status, and the support bundle's request contract.
 */

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

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

describe('operations routes', () => {
  it('reads job health with audit.read, and repairs only with tenant.manage, idempotently', async () => {
    const scheduler = createFakeScheduler();
    ctx = await buildTestApp({ scheduler: () => scheduler });
    const auditor = await cookieFor('auditor', [PERMISSIONS.AUDIT_READ]);
    const admin = await cookieFor('admin', [PERMISSIONS.TENANT_MANAGE, PERMISSIONS.AUDIT_READ]);

    // A preview left `running` seven hours ago by a process that is gone.
    const run = await withTenant(ctx.tenantId, async (tx) => {
      const source = await tx.directorySource.create({ data: { tenantId: ctx.tenantId, name: 'LDAP', config: {}, secretName: 'ldap' } });
      return tx.syncRun.create({ data: { tenantId: ctx.tenantId, sourceId: source.id, status: 'running', startedAt: new Date(Date.now() - 7 * 3_600_000) } });
    });

    const health = await call('GET', '/api/admin/job-health', auditor);
    expect(health.statusCode).toBe(200);
    const finding = (health.json() as { findings: { subjectId: string; repairs: string[] }[] }).findings.find((f) => f.subjectId === run.id);
    expect(finding?.repairs).toContain('mark_failed');

    const body = { kind: 'sync_run', subjectId: run.id, action: 'mark_failed', reason: 'worker lost during a node drain' };
    expect((await call('POST', '/api/admin/job-health/repair', auditor, body)).statusCode).toBe(403);
    expect((await call('POST', '/api/admin/job-health/repair', admin, { ...body, reason: 'short' })).statusCode).toBe(400);

    const repaired = await call('POST', '/api/admin/job-health/repair', admin, body);
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().repair).toMatchObject({ outcome: 'repaired', status: 'failed', previousStatus: 'running' });
    const again = await call('POST', '/api/admin/job-health/repair', admin, body);
    expect(again.json().repair).toMatchObject({ outcome: 'noop' });

    const refused = await call('POST', '/api/admin/job-health/repair', admin, { ...body, kind: 'lifecycle_operation', subjectId: randomUUID() });
    expect(refused.statusCode).toBe(409);

    const events = await withTenant(ctx.tenantId, (tx) => tx.auditEvent.findMany({ where: { action: { startsWith: 'job_health.' } } }));
    expect(events.map((e) => e.action)).toEqual(['job_health.mark_failed', 'job_health.mark_failed']);
  });

  it("serves the tenant's status to audit.read and the deployment's only to deployment.manage", async () => {
    ctx = await buildTestApp({ scheduler: () => createFakeScheduler() });
    const auditor = await cookieFor('auditor', [PERMISSIONS.AUDIT_READ]);
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE]);

    const status = await call('GET', '/api/admin/status', auditor);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      overall: expect.any(String),
      components: expect.arrayContaining([expect.objectContaining({ name: 'database', state: 'operational' })]),
      degradation: expect.objectContaining({ writeStop: expect.objectContaining({ active: false }) }),
    });

    expect((await call('GET', '/api/admin/deployment/status', auditor)).statusCode).toBe(403);
    const deployment = await call('GET', '/api/admin/deployment/status', operator);
    expect(deployment.statusCode).toBe(200);
    expect(deployment.json()).toMatchObject({ tenants: expect.objectContaining({ active: expect.any(Number) }) });
    expect(deployment.body).not.toContain(ctx.tenantId);
  });

  it('refuses a support bundle window longer than seven days before anything is recorded', async () => {
    const scheduler = createFakeScheduler();
    ctx = await buildTestApp({ scheduler: () => scheduler });
    const admin = await cookieFor('admin', [PERMISSIONS.TENANT_MANAGE]);
    const tooLong = await call('POST', '/api/admin/exports', admin, {
      kind: 'support_bundle',
      params: { from: new Date(Date.now() - 8 * 86_400_000).toISOString() },
    });
    expect(tooLong.statusCode).toBe(400);
    const accepted = await call('POST', '/api/admin/exports', admin, { kind: 'support_bundle' });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().export).toMatchObject({ kind: 'support_bundle', status: 'queued' });
    expect(scheduler.enqueued).toEqual([{ name: 'exports.generate', data: expect.objectContaining({ exportId: accepted.json().export.id }) }]);
  });
});
