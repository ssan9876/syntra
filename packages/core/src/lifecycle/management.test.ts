import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import {
  assignLifecycleOperation,
  acknowledgeLifecycleOperation,
  currentReadiness,
  previewMover,
  applyMover,
  recordReadinessCheck,
  lifecycleWorkMetrics,
  queueLifecycleAlerts,
} from './management.js';

let tenantId: string;
let personId: string;
let contractId: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({ data: { tenantId, givenName: 'Maya', familyName: 'Okafor' } });
    personId = person.id;
    contractId = (
      await tx.contract.create({
        data: {
          tenantId,
          personId,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01'),
          department: 'Finance',
          jobTitle: 'Analyst',
        },
      })
    ).id;
  });
});

describe('mover lifecycle', () => {
  it('binds apply to the exact employee revision and records field changes', async () => {
    const preview = await previewMover(tenantId, personId, 1, {
      department: 'Clinical Operations',
      jobTitle: 'Senior Analyst',
    });
    expect(preview.changes).toEqual([
      { field: 'department', before: 'Finance', after: 'Clinical Operations' },
      { field: 'jobTitle', before: 'Analyst', after: 'Senior Analyst' },
    ]);
    await withTenant(tenantId, (tx) =>
      tx.contract.update({ where: { id: contractId }, data: { location: 'Phoenix' } }),
    );
    await expect(
      applyMover(tenantId, preview, { enqueue: async () => 'unused' } as never),
    ).rejects.toThrow('changed since this preview');
  });
});

describe('persisted connection readiness', () => {
  it('returns current evidence only for the exact configuration fingerprint', async () => {
    await recordReadinessCheck(tenantId, {
      systemKind: 'target',
      systemId: '11111111-1111-4111-8111-111111111111',
      configuration: { url: 'ldaps://dc.test:636', bindDn: 'svc' },
      capabilities: ['read', 'createUser'],
      status: 'passed',
      latencyMs: 42,
    });
    expect(
      await currentReadiness(
        tenantId,
        'target',
        '11111111-1111-4111-8111-111111111111',
        { url: 'ldaps://dc.test:636', bindDn: 'svc' },
      ),
    ).toMatchObject({ current: true, status: 'passed', capabilities: ['read', 'createUser'] });
    expect(
      await currentReadiness(
        tenantId,
        'target',
        '11111111-1111-4111-8111-111111111111',
        { url: 'ldaps://other.test:636', bindDn: 'svc' },
      ),
    ).toMatchObject({ current: false });
  });
});

describe('lifecycle work ownership', () => {
  it('assigns, notifies once, and acknowledges unresolved work', async () => {
    const operation = await withTenant(tenantId, (tx) =>
      tx.lifecycleOperation.create({
        data: {
          tenantId,
          personId,
          kind: 'move',
          idempotencyKey: 'move-1',
          inputFingerprint: 'fingerprint',
          status: 'failed',
        },
      }),
    );
    const owner = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'owner', email: 'owner@acme.test', displayName: 'Owner' }),
    );

    await assignLifecycleOperation(tenantId, operation.id, owner.id, {
      priority: 'high',
      dueAt: new Date('2026-09-21T00:00:00Z'),
    });
    await assignLifecycleOperation(tenantId, operation.id, owner.id, {
      priority: 'high',
      dueAt: new Date('2026-09-21T00:00:00Z'),
    });
    const acknowledged = await acknowledgeLifecycleOperation(tenantId, operation.id);

    expect(acknowledged).toMatchObject({ ownerUserId: owner.id, priority: 'high' });
    expect(acknowledged.acknowledgedAt).toBeInstanceOf(Date);
    expect(
      await withTenant(tenantId, (tx) =>
        tx.notificationOutbox.count({ where: { template: 'lifecycle-assigned' } }),
      ),
    ).toBe(1);
  });
});

describe('lifecycle work metrics', () => {
  it('counts durable unresolved states and only unacknowledged overdue work', async () => {
    await withTenant(tenantId, (tx) => tx.lifecycleOperation.createMany({ data: [
      { tenantId, personId, kind: 'onboard', idempotencyKey: 'metrics-running', inputFingerprint: 'a', status: 'running' },
      { tenantId, personId, kind: 'verify', idempotencyKey: 'metrics-waiting', inputFingerprint: 'b', status: 'waiting', dueAt: new Date('2026-09-20T00:00:00Z') },
      { tenantId, personId, kind: 'move', idempotencyKey: 'metrics-failed', inputFingerprint: 'c', status: 'failed', dueAt: new Date('2026-09-20T00:00:00Z'), acknowledgedAt: new Date('2026-09-20T01:00:00Z') },
      { tenantId, personId, kind: 'move', idempotencyKey: 'metrics-complete', inputFingerprint: 'd', status: 'completed' },
    ] }));
    expect(await lifecycleWorkMetrics(tenantId, new Date('2026-09-21T00:00:00Z'))).toMatchObject({
      running: 1, waiting: 1, failed: 1, overdue: 1, unresolved: 3,
    });
  });
});

describe('lifecycle alerts', () => {
  it('queues each failed or overdue owner alert once until delivery', async () => {
    const owner = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'alerts-owner', email: 'alerts-owner@acme.test', displayName: 'Alert owner' }),
    );
    await withTenant(tenantId, (tx) => tx.lifecycleOperation.createMany({ data: [
      { tenantId, personId, kind: 'onboard', idempotencyKey: 'alert-failed', inputFingerprint: 'alert-1', status: 'failed', ownerUserId: owner.id },
      { tenantId, personId, kind: 'move', idempotencyKey: 'alert-overdue', inputFingerprint: 'alert-2', status: 'waiting', ownerUserId: owner.id, dueAt: new Date('2026-09-20T00:00:00Z') },
    ] }));
    const now = new Date('2026-09-21T00:00:00Z');
    expect(await queueLifecycleAlerts(tenantId, now)).toBe(2);
    expect(await queueLifecycleAlerts(tenantId, now)).toBe(0);
    expect(await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany({ orderBy: { template: 'asc' } })))
      .toMatchObject([{ template: 'lifecycle-failed', to: owner.email }, { template: 'lifecycle-overdue', to: owner.email }]);
  });
});
