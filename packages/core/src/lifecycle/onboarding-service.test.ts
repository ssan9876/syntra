import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { onboardPerson } from './onboarding-service.js';

let tenantId: string;
let targetId: string;
const scheduler = () => ({ enqueue: vi.fn(async () => 'job-1') }) as unknown as Scheduler;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  targetId = await withTenant(tenantId, async (tx) =>
    (
      await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Directory',
          config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' },
          secretName: 'target/test',
        },
      })
    ).id,
  );
});

describe('durable onboarding', () => {
  it('replays one request without duplicating person, contract, login, or target receipt', async () => {
    const jobs = scheduler();
    const request = {
      tenantId,
      idempotencyKey: 'HR-1042',
      person: { givenName: 'Maya', familyName: 'Okafor', externalId: 'HR-1042' },
      contract: { sequence: 1, isPrimary: true, startDate: new Date('2026-10-01') },
      login: { login: 'maya.okafor', email: 'maya@acme.test', displayName: 'Maya Okafor' },
      targetIds: [targetId],
      scheduler: jobs,
    };

    const first = await onboardPerson(request);
    const replayed = await onboardPerson(request);

    expect(replayed.operation.id).toBe(first.operation.id);
    expect(replayed.person.id).toBe(first.person.id);
    expect(await withTenant(tenantId, (tx) => tx.person.count())).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.contract.count())).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.user.count())).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.personProvisionReceipt.count())).toBe(1);
    expect(jobs.enqueue).toHaveBeenCalledOnce();
  });

  it('keeps local creation atomic when the requested login conflicts', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          login: 'maya.okafor',
          email: 'existing@acme.test',
          displayName: 'Existing',
        },
      }),
    );

    await expect(
      onboardPerson({
        tenantId,
        idempotencyKey: 'HR-1043',
        person: { givenName: 'Maya', familyName: 'Okafor' },
        contract: { sequence: 1, isPrimary: true, startDate: new Date('2026-10-01') },
        login: { login: 'maya.okafor', email: 'maya@acme.test', displayName: 'Maya Okafor' },
        targetIds: [targetId],
        scheduler: scheduler(),
      }),
    ).rejects.toThrow('login already exists');

    expect(await withTenant(tenantId, (tx) => tx.person.count())).toBe(0);
    const operation = await withTenant(tenantId, (tx) =>
      tx.lifecycleOperation.findFirstOrThrow({ include: { steps: true } }),
    );
    expect(operation.status).toBe('failed');
    expect(operation.steps.find((step) => step.key === 'local')).toMatchObject({
      status: 'failed',
    });
  });
});
