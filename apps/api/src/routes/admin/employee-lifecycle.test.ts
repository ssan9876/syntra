import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { assignRole, createRole, createSession, createUser, PERMISSIONS, type Permission } from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
beforeEach(async () => { ctx = await buildTestApp(); });
afterEach(async () => { await ctx?.app.close(); });
async function fixture(permissions: Permission[] = [PERMISSIONS.IDENTITY_READ, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.PROVISION_READ, PERMISSIONS.PROVISION_MANAGE]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const admin = await createUser(tx, { login: 'operator', email: 'operator@test.test', displayName: 'Operator' });
    const role = await createRole(tx, 'Operator', permissions);
    await assignRole(tx, admin.id, role.id);
    const session = await createSession(tx, { status: 'allow', userId: admin.id, mayElevate: true, scope: 'admin', applicationId: null, satisfiedFactor: null }, { ip: null, userAgent: null });
    const person = await tx.person.create({ data: { tenantId: ctx.tenantId, givenName: 'Maya', familyName: 'Okafor' } });
    const employee = await createUser(tx, { login: 'maya', email: 'maya@test.test', displayName: 'Maya' });
    await tx.user.update({ where: { id: employee.id }, data: { personId: person.id } });
    const employeeSession = await createSession(tx, { status: 'allow', userId: employee.id, mayElevate: false, scope: 'portal', applicationId: null, satisfiedFactor: null }, { ip: null, userAgent: null });
    return { person, employee, employeeSession, cookie: `syntra_session=${session.token}` };
  });
}
const read = (id: string, cookie: string) => ctx.app.inject({ method: 'GET', url: `/api/admin/persons/${id}/offboarding`, headers: { host: ctx.host, cookie } });
const end = (id: string, cookie: string, revision: string) => ctx.app.inject({ method: 'POST', url: `/api/admin/persons/${id}/offboarding`, headers: { host: ctx.host, cookie }, payload: { reason: 'Employment ended', revision } });

describe('employee offboarding', () => {
  it('previews and ends linked local sign-ins, persists departure and audit evidence', async () => {
    const f = await fixture();
    const preview = await read(f.person.id, f.cookie);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().accounts).toEqual([expect.objectContaining({ id: f.employee.id, status: 'active' })]);
    const response = await end(f.person.id, f.cookie, preview.json().revision);
    expect(response.statusCode).toBe(200);
    expect(response.json().operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.json().results).toContainEqual(expect.objectContaining({ userId: f.employee.id, status: 'disabled' }));
    await withTenant(ctx.tenantId, async (tx) => {
      expect((await tx.person.findUniqueOrThrow({ where: { id: f.person.id } })).status).toBe('inactive');
      expect((await tx.user.findUniqueOrThrow({ where: { id: f.employee.id } })).status).toBe('inactive');
      expect(await tx.auditEvent.count({ where: { targetId: f.person.id, action: 'person.offboarding.finished' } })).toBe(1);
      expect(await tx.session.count({ where: { userId: f.employee.id, revokedAt: null } })).toBe(0);
      expect(await tx.lifecycleOperation.findUniqueOrThrow({ where: { id: response.json().operationId } })).toMatchObject({
        personId: f.person.id,
        kind: 'offboard',
        status: 'completed',
      });
    });
    const sessionRead = await ctx.app.inject({ method: 'GET', url: '/api/session', headers: { host: ctx.host, cookie: `syntra_session=${f.employeeSession.token}` } });
    expect(sessionRead.statusCode).not.toBe(200);
    expect((await read(f.person.id, f.cookie)).json().latestAttempt).not.toBeNull();
  });

  it('refuses stale previews before changing employment or accounts', async () => {
    const f = await fixture();
    const preview = await read(f.person.id, f.cookie);
    await withTenant(ctx.tenantId, (tx) => tx.user.update({ where: { id: f.employee.id }, data: { personId: null } }));
    expect((await end(f.person.id, f.cookie, preview.json().revision)).statusCode).toBe(409);
    expect(await withTenant(ctx.tenantId, (tx) => tx.person.findUniqueOrThrow({ where: { id: f.person.id } }))).toMatchObject({ status: 'active' });
  });

  it('requires all write permissions and rejects cross-tenant/missing people', async () => {
    const f = await fixture([PERMISSIONS.IDENTITY_READ, PERMISSIONS.DIRECTORY_READ, PERMISSIONS.PROVISION_READ]);
    const preview = await read(f.person.id, f.cookie);
    expect((await end(f.person.id, f.cookie, preview.json().revision)).statusCode).toBe(403);
    expect((await read('00000000-0000-4000-8000-000000000000', f.cookie)).statusCode).toBe(404);
  });

  it('returns filtered employee work counts from the same unresolved rows', async () => {
    const f = await fixture();
    await withTenant(ctx.tenantId, async (tx) => {
      const target = await tx.targetSystem.create({ data: {
        tenantId: ctx.tenantId,
        name: 'Directory',
        config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' },
        secretName: 'target/test',
      } });
      await tx.personProvisionReceipt.create({ data: {
        tenantId: ctx.tenantId,
        personId: f.person.id,
        targetSystemId: target.id,
        targetName: target.name,
        requestKey: '11111111-1111-4111-8111-111111111111',
        status: 'failed',
        message: 'Directory unavailable',
      } });
      await tx.person.update({ where: { id: f.person.id }, data: { status: 'inactive' } });
    });
    const response = await ctx.app.inject({ method: 'GET', url: '/api/admin/employee-work', headers: { host: ctx.host, cookie: f.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toEqual({ onboarding: 0, offboarding: 1, failed: 1, total: 2 });
    expect(response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'failed', personId: f.person.id, summary: expect.stringContaining('Directory unavailable') }),
      expect.objectContaining({ kind: 'offboarding', personId: f.person.id, summary: expect.stringContaining('1 active sign-in') }),
    ]));
    await withTenant(ctx.tenantId, async (tx) => {
      const failed = await tx.personProvisionReceipt.findFirstOrThrow({ where: { personId: f.person.id } });
      await tx.personProvisionReceipt.create({ data: {
        tenantId: ctx.tenantId,
        personId: f.person.id,
        targetSystemId: failed.targetSystemId,
        targetName: failed.targetName,
        requestKey: '22222222-2222-4222-8222-222222222222',
        status: 'applied',
        updatedAt: new Date('2099-01-01T00:00:00Z'),
      } });
    });
    const resolved = await ctx.app.inject({ method: 'GET', url: '/api/admin/employee-work', headers: { host: ctx.host, cookie: f.cookie } });
    expect(resolved.json().counts).toEqual({ onboarding: 0, offboarding: 1, failed: 0, total: 1 });
  });

  it('puts each item in one lane, filters by it, and keeps every lane count when a lane is empty', async () => {
    const f = await fixture();
    await withTenant(ctx.tenantId, async (tx) => {
      const target = await tx.targetSystem.create({ data: {
        tenantId: ctx.tenantId,
        name: 'Directory',
        config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' },
        secretName: 'target/test',
      } });
      const waiting = await tx.person.create({ data: { tenantId: ctx.tenantId, givenName: 'Wen', familyName: 'Ito' } });
      await tx.personProvisionReceipt.create({ data: {
        tenantId: ctx.tenantId, personId: waiting.id, targetSystemId: target.id, targetName: target.name,
        requestKey: '33333333-3333-4333-8333-333333333333', status: 'verification_pending',
      } });
      await tx.personProvisionReceipt.create({ data: {
        tenantId: ctx.tenantId, personId: f.person.id, targetSystemId: target.id, targetName: target.name,
        requestKey: '44444444-4444-4444-8444-444444444444', status: 'failed', message: 'Directory unavailable',
      } });
    });
    const get = (query = '') => ctx.app.inject({ method: 'GET', url: `/api/admin/employee-work${query}`, headers: { host: ctx.host, cookie: f.cookie } });

    const all = (await get()).json();
    expect(all.lanes).toEqual({ action: 0, waiting: 1, blocked: 1, overdue: 0 });
    // Blocked sorts ahead of waiting whatever their age.
    expect(all.items.map((item: { lane: string }) => item.lane)).toEqual(['blocked', 'waiting']);
    expect(all.items[0]).toMatchObject({ targetName: 'Directory' });

    const waiting = (await get('?lane=waiting')).json();
    expect(waiting.items).toEqual([expect.objectContaining({ personName: 'Wen Ito', lane: 'waiting' })]);
    expect(waiting.total).toBe(1);

    const overdue = (await get('?lane=overdue')).json();
    expect(overdue.items).toEqual([]);
    expect(overdue.lanes).toEqual(all.lanes);
    expect(overdue.counts).toEqual(all.counts);

    expect((await get('?lane=later')).statusCode).toBe(400);
  });

  it('shows one lifecycle operation instead of duplicating its target receipts', async () => {
    const f = await fixture();
    await withTenant(ctx.tenantId, async (tx) => {
      const operation = await tx.lifecycleOperation.create({
        data: {
          tenantId: ctx.tenantId,
          personId: f.person.id,
          kind: 'move',
          idempotencyKey: 'move-work-1',
          inputFingerprint: 'fingerprint',
          status: 'failed',
          priority: 'high',
          dueAt: new Date('2026-09-19T00:00:00Z'),
        },
      });
      const target = await tx.targetSystem.create({
        data: {
          tenantId: ctx.tenantId,
          name: 'Directory',
          config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' },
          secretName: 'target/test',
        },
      });
      await tx.personProvisionReceipt.create({
        data: {
          tenantId: ctx.tenantId,
          personId: f.person.id,
          targetSystemId: target.id,
          targetName: target.name,
          requestKey: operation.id,
          status: 'failed',
          message: 'Directory unavailable',
        },
      });
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/employee-work',
      headers: { host: ctx.host, cookie: f.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({
        kind: 'failed',
        lifecycleKind: 'move',
        personId: f.person.id,
        priority: 'high',
        overdue: true,
      }),
    ]);
  });
});
