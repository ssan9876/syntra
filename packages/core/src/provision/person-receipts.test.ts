import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { DEFERRAL_SECONDS, requestPersonProvision, retryPersonProvision, runPersonProvision } from './person-receipts.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { updateLifecyclePolicy } from '../lifecycle/policy.js';

let tenantId: string;
let personId: string;
let targetId: string;
const key = '11111111-1111-4111-8111-111111111111';
function scheduler(jobId: string | null = 'job-1') {
  return { enqueue: vi.fn(async () => jobId) } as unknown as Scheduler;
}
beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  await withTenant(tenantId, async (tx) => {
    personId = (await tx.person.create({ data: { tenantId, givenName: 'Maya', familyName: 'Okafor' } })).id;
    targetId = (await tx.targetSystem.create({ data: { tenantId, name: 'AD', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/test' } })).id;
  });
});

describe('person provisioning receipts', () => {
  it('is idempotent per person, target and request and queues exactly once', async () => {
    const jobs = scheduler();
    const first = await requestPersonProvision(tenantId, personId, key, jobs, [targetId]);
    const second = await requestPersonProvision(tenantId, personId, key, jobs, [targetId]);
    expect(first).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(jobs.enqueue).toHaveBeenCalledOnce();
    expect(first[0]).toMatchObject({ personId, targetSystemId: targetId, status: 'pending', jobId: 'job-1' });
  });

  it('persists queue refusal as retryable failure and retries only the saved receipt', async () => {
    const refused = scheduler(null);
    const [receipt] = await requestPersonProvision(tenantId, personId, key, refused, [targetId]);
    expect(receipt).toMatchObject({ status: 'failed', jobId: null });
    const accepted = scheduler('job-2');
    const retried = await retryPersonProvision(tenantId, personId, receipt!.id, accepted);
    expect(retried).toMatchObject({ id: receipt!.id, personId, status: 'pending', jobId: 'job-2' });
    expect(accepted.enqueue).toHaveBeenCalledWith('provision.person', { tenantId, receiptId: receipt!.id });
  });
});

describe('tenant concurrency cap', () => {
  it('defers a receipt visibly and requeues it later when the tenant is at capacity', async () => {
    await updateLifecyclePolicy(tenantId, { maxConcurrentTargetOperations: 1 }, null);
    const jobs = scheduler('job-9');
    const [first, second] = await withTenant(tenantId, async (tx) => {
      const other = await tx.targetSystem.create({ data: { tenantId, name: 'AD2', config: { url: 'ldaps://dc2.test:636', tlsMode: 'ldaps' }, secretName: 'target/test2' } });
      const busy = await tx.personProvisionReceipt.create({ data: { tenantId, personId, targetSystemId: targetId, targetName: 'AD', requestKey: '00000000-0000-4000-8000-000000000001', status: 'planning' } });
      const waiting = await tx.personProvisionReceipt.create({ data: { tenantId, personId, targetSystemId: other.id, targetName: 'AD2', requestKey: '00000000-0000-4000-8000-000000000002', status: 'pending' } });
      return [busy, waiting];
    });
    await runPersonProvision(jobs, localMasterKeyProvider(Buffer.alloc(32, 7)), { tenantId, receiptId: second.id });
    const deferred = await withTenant(tenantId, (tx) => tx.personProvisionReceipt.findUniqueOrThrow({ where: { id: second.id } }));
    expect(deferred.status).toBe('deferred');
    expect(deferred.message).toContain('1 of 1 target operations in flight');
    expect((deferred.evidence as { deferrals: number }).deferrals).toBe(1);
    expect(jobs.enqueue).toHaveBeenCalledWith('provision.person', { tenantId, receiptId: second.id }, { startAfterSeconds: DEFERRAL_SECONDS });
    // The busy one is untouched, and nothing was planned for the deferred one.
    const stillBusy = await withTenant(tenantId, (tx) => tx.personProvisionReceipt.findUniqueOrThrow({ where: { id: first.id } }));
    expect(stillBusy.status).toBe('planning');
    expect(await withTenant(tenantId, (tx) => tx.provisionRun.count())).toBe(0);
  });
});
