import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { verifyChain } from '../audit/audit-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { ExternalWritesPausedError, pauseTargetExternalWrites } from './target-write-stop.js';
import {
  assertExternalWritesAllowed,
  pauseTenantExternalWrites,
  resumeTenantExternalWrites,
  tenantExternalWriteStop,
  TenantWriteStopSeparationError,
  TenantWriteStopStateError,
} from './tenant-write-stop.js';
import {
  expireExternalWriteStops,
  registerWriteStopJobs,
  scheduleWriteStopExpiry,
  WRITE_STOP_EXPIRY_JOB,
} from './write-stop-expiry.js';

let tenantId: string; let otherTenantId: string; let targetId: string; let first: string; let second: string;
const now = new Date('2026-09-23T12:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);

const actions = () =>
  withTenant(tenantId, async (tx) =>
    (await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } })).map((event) => event.action));

const target = () => withTenant(tenantId, (tx) => tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }));

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } })).id;
  await withTenant(tenantId, async (tx) => {
    first = (await createUser(tx, { login: 'first', email: 'first@acme.test', displayName: 'First' })).id;
    second = (await createUser(tx, { login: 'second', email: 'second@acme.test', displayName: 'Second' })).id;
    targetId = (await tx.targetSystem.create({ data: { tenantId, name: 'AD', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 's' } })).id;
  });
});

describe('tenant external-write stop', () => {
  it('refuses every target in the tenant while active, and names the tenant scope', async () => {
    await pauseTenantExternalWrites(tenantId, first, 'Suspected compromised administrator', null, now);
    const row = await target();
    const refusal = await withTenant(tenantId, (tx) => assertExternalWritesAllowed(tx, row, now)).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ExternalWritesPausedError);
    expect(refusal).toMatchObject({ scope: 'tenant', reason: 'Suspected compromised administrator', targetSystemId: targetId });
  });

  it('prefers the tenant stop when both scopes are active', async () => {
    await pauseTargetExternalWrites(tenantId, targetId, first, 'Target incident', null, now);
    await pauseTenantExternalWrites(tenantId, first, 'Tenant incident', null, now);
    const row = await target();
    await expect(withTenant(tenantId, (tx) => assertExternalWritesAllowed(tx, row, now)))
      .rejects.toMatchObject({ scope: 'tenant' });
  });

  it('is isolated to its tenant', async () => {
    await pauseTenantExternalWrites(tenantId, first, 'Contain', null, now);
    expect((await tenantExternalWriteStop(otherTenantId, now)).active).toBe(false);
    const rows = await withTenant(otherTenantId, (tx) => tx.tenantExternalWriteStop.findMany());
    expect(rows).toEqual([]);
  });

  it('requires a different administrator to resume and audits both decisions in the chain', async () => {
    const paused = await pauseTenantExternalWrites(tenantId, first, 'Contain HR feed', later(60_000), now);
    expect(paused).toMatchObject({ active: true, pausedByUserId: first, pauseReason: 'Contain HR feed' });
    await expect(pauseTenantExternalWrites(tenantId, second, 'Again', null, now)).rejects.toBeInstanceOf(TenantWriteStopStateError);
    await expect(resumeTenantExternalWrites(tenantId, first, 'Looks fixed', now)).rejects.toBeInstanceOf(TenantWriteStopSeparationError);
    const resumed = await resumeTenantExternalWrites(tenantId, second, 'Feed corrected and re-previewed', now);
    expect(resumed).toMatchObject({ active: false, pausedAt: null, resumedByUserId: second });
    await expect(resumeTenantExternalWrites(tenantId, second, 'Twice', now)).rejects.toBeInstanceOf(TenantWriteStopStateError);
    expect(await actions()).toEqual([
      'provision.tenant.external_writes.pause', 'provision.tenant.external_writes.resume',
    ]);
    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toMatchObject({ valid: true });
  });

  it('refuses an expiry that is not in the future', async () => {
    await expect(pauseTenantExternalWrites(tenantId, first, 'Contain', now, now)).rejects.toBeInstanceOf(TenantWriteStopStateError);
  });

  it('honours the expiry at the boundary before any sweep has run', async () => {
    await pauseTenantExternalWrites(tenantId, first, 'Contain', later(60_000), now);
    const row = await target();
    await expect(withTenant(tenantId, (tx) => assertExternalWritesAllowed(tx, row, later(60_000)))).resolves.toBeUndefined();
    expect((await tenantExternalWriteStop(tenantId, later(60_000))).active).toBe(false);
  });

  it('notifies subscribed endpoints of a stop, a resume and an expiry', async () => {
    await withTenant(tenantId, (tx) => tx.webhookEndpoint.create({
      data: { tenantId, name: 'On call', url: 'https://oncall.example.test/in', enabled: true, events: ['write-stops'] },
    }));
    await pauseTenantExternalWrites(tenantId, first, 'Contain', null, now);
    await resumeTenantExternalWrites(tenantId, second, 'Clear', now);
    await pauseTargetExternalWrites(tenantId, targetId, first, 'Target only', later(1_000), now);
    await expireExternalWriteStops(tenantId, later(1_000));
    const deliveries = await withTenant(tenantId, (tx) => tx.webhookDelivery.findMany({ orderBy: { createdAt: 'asc' } }));
    expect(deliveries.map((d) => d.event).sort()).toEqual([
      'provision.target.external_writes.expire',
      'provision.target.external_writes.pause',
      'provision.tenant.external_writes.pause',
      'provision.tenant.external_writes.resume',
    ]);
    // The projection, not the audit payload: the reason stays inside.
    expect(JSON.stringify(deliveries.map((d) => d.payload))).not.toContain('Contain');
  });
});

describe('write-stop expiry sweep', () => {
  it('closes lapsed stops at both scopes exactly once, with no actor', async () => {
    await pauseTenantExternalWrites(tenantId, first, 'Tenant hold', later(1_000), now);
    await pauseTargetExternalWrites(tenantId, targetId, first, 'Target hold', later(2_000), now);
    expect(await expireExternalWriteStops(tenantId, later(1_500))).toEqual({ targets: 0, tenant: true });
    expect(await expireExternalWriteStops(tenantId, later(3_000))).toEqual({ targets: 1, tenant: false });
    expect(await expireExternalWriteStops(tenantId, later(4_000))).toEqual({ targets: 0, tenant: false });

    const stop = await tenantExternalWriteStop(tenantId, later(4_000));
    expect(stop).toMatchObject({ active: false, pausedAt: null, resumedAt: later(1_000), resumedByUserId: null });
    expect(await target()).toMatchObject({ externalWritesPausedAt: null, externalWritesResumedAt: later(2_000), externalWritesResumedByUserId: null });

    const expiries = await withTenant(tenantId, (tx) => tx.auditEvent.findMany({
      where: { action: { endsWith: '.external_writes.expire' } }, orderBy: { sequence: 'asc' },
    }));
    expect(expiries.map((e) => [e.action, e.actorUserId])).toEqual([
      ['provision.tenant.external_writes.expire', null],
      ['provision.target.external_writes.expire', null],
    ]);
    expect(expiries[0]!.payload).toMatchObject({ reason: 'Tenant hold', pausedByUserId: first });
  });

  it('leaves an active stop and a stop without expiry alone', async () => {
    await pauseTenantExternalWrites(tenantId, first, 'Indefinite', null, now);
    await pauseTargetExternalWrites(tenantId, targetId, first, 'Later', later(60_000), now);
    expect(await expireExternalWriteStops(tenantId, later(30_000))).toEqual({ targets: 0, tenant: false });
    expect((await tenantExternalWriteStop(tenantId, later(30_000))).active).toBe(true);
  });

  it('announces a lapsed stop that a new stop replaces before the sweep saw it', async () => {
    await pauseTenantExternalWrites(tenantId, first, 'First hold', later(1_000), now);
    await pauseTenantExternalWrites(tenantId, second, 'Second hold', null, later(5_000));
    expect(await actions()).toEqual([
      'provision.tenant.external_writes.pause',
      'provision.tenant.external_writes.expire',
      'provision.tenant.external_writes.pause',
    ]);
  });

  it('runs every minute per tenant', async () => {
    const scheduler = { register: vi.fn(), schedule: vi.fn() } as unknown as Scheduler;
    registerWriteStopJobs(scheduler);
    await scheduleWriteStopExpiry(scheduler, 'tenant-1');
    expect(scheduler.register).toHaveBeenCalledWith(WRITE_STOP_EXPIRY_JOB, expect.any(Function));
    expect(scheduler.schedule).toHaveBeenCalledWith(WRITE_STOP_EXPIRY_JOB, '* * * * *', { tenantId: 'tenant-1' }, 'write-stop-expiry-tenant-1');
  });
});
