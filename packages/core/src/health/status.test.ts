import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import type { QueueInspector } from '../jobs/job-health.js';
import { configurationFingerprint } from '../lifecycle/management.js';
import { localMasterKeyProvider, type MasterKeyProvider } from '../vault/master-key.js';
import { componentHealth, deploymentStatus, tenantStatus, type StatusComponent } from './status.js';

/*
 * Customer-safe status reporting (backlog #63): a tenant sees the shared
 * components and its OWN degradation; the operator sees counts.
 */

const provider = localMasterKeyProvider(randomBytes(32));
const empty: QueueInspector = async () => [];
const healthy: StatusComponent[] = [
  { name: 'api', state: 'operational', detail: '' },
  { name: 'database', state: 'operational', detail: '' },
];

let tenantId: string;
let otherTenantId: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } })).id;
});

const target = (id: string, name: string, config: Record<string, unknown> = { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }) =>
  withTenant(id, (tx) => tx.targetSystem.create({ data: { tenantId: id, name, config: config as never, secretName: 's' } }));

describe('componentHealth', () => {
  it('reports each shared component, and a key provider or mail server that does not answer as unavailable', async () => {
    const broken: MasterKeyProvider = { ...provider, name: 'vault-transit', check: async () => { throw new Error('connection refused to 10.0.0.5'); } };
    const components = await componentHealth({
      provider: broken,
      schedulerRunning: () => false,
      transport: { send: async () => {}, verify: async () => { throw new Error('smtp auth failed for ops@acme.test'); } },
      timeoutMs: 2_000,
    });
    expect(Object.fromEntries(components.map((c) => [c.name, c.state]))).toEqual({
      api: 'operational',
      database: 'operational',
      queue: 'unavailable',
      key_provider: 'unavailable',
      smtp: 'unavailable',
    });
    // Causes are not repeated: no host, no address.
    const text = JSON.stringify(components);
    expect(text).not.toContain('10.0.0.5');
    expect(text).not.toContain('ops@acme.test');

    const unchecked = await componentHealth({ provider, transport: { send: async () => {} } });
    expect(unchecked.find((c) => c.name === 'smtp')?.state).toBe('unknown');
    expect(unchecked.find((c) => c.name === 'queue')?.state).toBe('unknown');
    expect(unchecked.find((c) => c.name === 'key_provider')?.state).toBe('operational');
  });
});

describe('tenantStatus', () => {
  it("reports this tenant's write stops, stale readiness and outages, and nothing of another tenant's", async () => {
    const fresh = await target(tenantId, 'Fresh');
    const changed = await target(tenantId, 'Changed');
    await target(tenantId, 'Untested');
    const failing = await target(tenantId, 'Failing');
    const theirs = await target(otherTenantId, 'Their AD');
    await withTenant(tenantId, async (tx) => {
      await tx.connectionReadinessCheck.create({ data: { tenantId, systemKind: 'target', systemId: fresh.id, configurationFingerprint: configurationFingerprint(fresh.config), status: 'passed' } });
      await tx.connectionReadinessCheck.create({ data: { tenantId, systemKind: 'target', systemId: changed.id, configurationFingerprint: 'stale', status: 'passed' } });
      await tx.connectionReadinessCheck.create({ data: { tenantId, systemKind: 'target', systemId: failing.id, configurationFingerprint: configurationFingerprint(failing.config), status: 'failed', message: 'HTTP 401 unauthorized for svc@acme.test' } });
      await tx.targetSystem.update({ where: { id: fresh.id }, data: { externalWritesPausedAt: new Date(), externalWritesPauseReason: 'incident' } });
      await tx.tenantExternalWriteStop.create({ data: { tenantId, pausedAt: new Date(), pausedByUserId: randomUUID(), pauseReason: 'incident' } });
    });
    await withTenant(otherTenantId, async (tx) => {
      await tx.connectionReadinessCheck.create({ data: { tenantId: otherTenantId, systemKind: 'target', systemId: theirs.id, configurationFingerprint: 'x', status: 'failed', message: 'down' } });
      await tx.provisionRun.create({ data: { tenantId: otherTenantId, targetSystemId: theirs.id, status: 'failed', error: 'down' } });
    });

    const status = await tenantStatus(tenantId, healthy, { inspector: empty });
    expect(status.overall).toBe('degraded');
    expect(status.degradation.writeStop.active).toBe(true);
    expect(status.degradation.targetWriteStops.map((t) => t.name)).toEqual(['Fresh']);
    expect(status.degradation.staleReadiness.map((r) => [r.name, r.reason]).sort()).toEqual([
      ['Changed', 'configuration_changed'],
      ['Failing', 'failing'],
      ['Untested', 'never_tested'],
    ]);
    expect(status.degradation.connectorOutages).toEqual([
      expect.objectContaining({ systemKind: 'target', name: 'Failing', errorClass: 'unauthorized', evidence: 'readiness_check' }),
    ]);
    const text = JSON.stringify(status);
    expect(text).not.toContain('Their AD');
    expect(text).not.toContain(theirs.id);
    expect(text).not.toContain('svc@acme.test');
  });

  it('is operational when nothing is wrong and the components are healthy', async () => {
    const status = await tenantStatus(tenantId, healthy, { inspector: empty });
    expect(status.overall).toBe('operational');
    expect(status.degradation.jobs.orphaned).toBe(0);
    const down = await tenantStatus(tenantId, [{ name: 'database', state: 'unavailable', detail: '' }], { inspector: empty });
    expect(down.overall).toBe('unavailable');
  });
});

describe('deploymentStatus', () => {
  it('counts degraded tenants without naming any', async () => {
    await withTenant(otherTenantId, (tx) => tx.tenantExternalWriteStop.create({ data: { tenantId: otherTenantId, pausedAt: new Date(), pausedByUserId: randomUUID(), pauseReason: 'incident' } }));
    const status = await deploymentStatus({ provider, schedulerRunning: () => true, inspector: empty });
    expect(status.tenants).toEqual({ active: 2, withWriteStop: 1, withJobTrouble: 0 });
    expect(status.migrations?.applied).toBeGreaterThan(80);
    expect(status.probes.map((p) => p.name)).toContain('database');
    const text = JSON.stringify(status);
    expect(text).not.toContain(tenantId);
    expect(text).not.toContain(otherTenantId);
    expect(text).not.toContain('acme');
  });
});
