import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { targetConnectorHealth } from './target-health.js';

let tenantId: string;
let targetId: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  targetId = await withTenant(tenantId, async (tx) => (await tx.targetSystem.create({
    data: { tenantId, name: 'Directory', config: { url: 'ldaps://directory.test:636', tlsMode: 'ldaps' }, secretName: 'target-secret' },
  })).id);
});

describe('target connector health time series', () => {
  it('derives daily authentication, latency, retry, throttle and read-back metrics from durable evidence', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.connectionReadinessCheck.createMany({ data: [
        { tenantId, systemKind: 'target', systemId: targetId, configurationFingerprint: 'a', status: 'passed', latencyMs: 40, checkedAt: new Date('2026-09-22T01:00:00Z') },
        { tenantId, systemKind: 'target', systemId: targetId, configurationFingerprint: 'a', status: 'failed', latencyMs: 100, message: 'Token endpoint answered HTTP 401', checkedAt: new Date('2026-09-22T02:00:00Z') },
      ] });
      await tx.provisionRun.create({
        data: {
          tenantId, targetSystemId: targetId, startedAt: new Date('2026-09-22T03:00:00Z'),
          actions: { create: [
            { tenantId, actionType: 'update_account', sequence: 0, status: 'applied', attempts: 2, createdAt: new Date('2026-09-22T03:01:00Z') },
            { tenantId, actionType: 'grant_entitlement', sequence: 1, status: 'failed', attempts: 3, message: 'Target throttled with HTTP 429', createdAt: new Date('2026-09-22T03:02:00Z') },
            { tenantId, actionType: 'create_account', sequence: 2, status: 'in_flight', attempts: 1, message: 'Outcome could not be persisted', createdAt: new Date('2026-09-22T03:03:00Z') },
          ] },
        },
      });
      await tx.lifecycleOperation.create({
        data: {
          tenantId, kind: 'verify', idempotencyKey: 'health-observation', inputFingerprint: 'x',
          steps: { create: { tenantId, key: 'target', title: 'Verify', position: 0, observations: { create: {
            tenantId, targetSystemId: targetId, completeness: 'incomplete', matches: false,
            expected: {}, differences: [], observedAt: new Date('2026-09-22T04:00:00Z'),
          } } } },
        },
      });
    });
    const health = await targetConnectorHealth(tenantId, targetId, { days: 3, now: new Date('2026-09-23T12:00:00Z') });
    expect(health?.series).toHaveLength(3);
    expect(health?.series[1]).toMatchObject({
      date: '2026-09-22', readinessChecks: 2, readinessFailures: 1, authenticationFailures: 1,
      averageLatencyMs: 70, p95LatencyMs: 100, provisionActions: 3, failedActions: 1, ambiguousActions: 1,
      throttledActions: 1, retries: 3, readBackChecks: 1, incompleteReadBacks: 1,
    });
    expect(health?.totals).toMatchObject({ authenticationFailures: 1, ambiguousActions: 1, throttledActions: 1, retries: 3, incompleteReadBacks: 1 });
  });

  it('returns null for a target outside the tenant', async () => {
    expect(await targetConnectorHealth(tenantId, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
