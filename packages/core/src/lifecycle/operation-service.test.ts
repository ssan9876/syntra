import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  createLifecycleOperation,
  lifecycleInputFingerprint,
  getLifecycleOperation,
  retryLifecycleOperation,
  assertRetryAfterVerification,
  transitionLifecycleStep,
} from './operation-service.js';

let tenantId: string;
let otherTenantId: string;
let personId: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } })).id;
  personId = await withTenant(tenantId, async (tx) =>
    (await tx.person.create({ data: { tenantId, givenName: 'Maya', familyName: 'Okafor' } })).id,
  );
});

describe('lifecycle operations', () => {
  it('uses one idempotency fingerprint for equivalent object key orders', () => {
    expect(lifecycleInputFingerprint({ person: { familyName: 'Doe', givenName: 'Jane' } }))
      .toBe(lifecycleInputFingerprint({ person: { givenName: 'Jane', familyName: 'Doe' } }));
  });

  it('returns one operation for repeated tenant-scoped idempotency keys', async () => {
    const input = {
      tenantId,
      personId,
      kind: 'onboard' as const,
      idempotencyKey: 'hire-HR-1042',
      input: { externalId: 'HR-1042' },
      steps: [
        { key: 'person', title: 'Save employee', required: true },
        { key: 'targets', title: 'Provision targets', required: true },
      ],
    };
    const first = await createLifecycleOperation(input);
    const repeated = await createLifecycleOperation(input);

    expect(repeated.id).toBe(first.id);
    expect(repeated.steps.map((step) => [step.key, step.position])).toEqual([
      ['person', 0],
      ['targets', 1],
    ]);
    expect(await withTenant(tenantId, (tx) => tx.lifecycleOperation.count())).toBe(1);
  });

  it('rejects a reused idempotency key whose input changed', async () => {
    await createLifecycleOperation({
      tenantId,
      kind: 'onboard',
      idempotencyKey: 'hire-HR-1042-changed',
      input: { employeeReference: 'HR-1042' },
      steps: [{ key: 'employee', title: 'Save employee', required: true }],
    });

    await expect(createLifecycleOperation({
      tenantId,
      kind: 'onboard',
      idempotencyKey: 'hire-HR-1042-changed',
      input: { employeeReference: 'HR-1043' },
      steps: [{ key: 'employee', title: 'Save employee', required: true }],
    })).rejects.toThrow('already used with different input');
  });

  it('does not expose an operation to another tenant', async () => {
    const created = await createLifecycleOperation({
      tenantId,
      personId,
      kind: 'onboard',
      idempotencyKey: 'hire-HR-1043',
      input: {},
      steps: [{ key: 'person', title: 'Save employee', required: true }],
    });

    await expect(getLifecycleOperation(otherTenantId, created.id)).rejects.toThrow();
  });

  it('enforces step order and derives operation completion from required steps', async () => {
    const operation = await createLifecycleOperation({
      tenantId,
      personId,
      kind: 'onboard',
      idempotencyKey: 'hire-HR-1044',
      input: {},
      steps: [
        { key: 'person', title: 'Save employee', required: true },
        { key: 'targets', title: 'Provision targets', required: true },
      ],
    });

    await expect(
      transitionLifecycleStep(tenantId, operation.id, 'targets', 'running'),
    ).rejects.toThrow('Complete earlier required steps');
    await transitionLifecycleStep(tenantId, operation.id, 'person', 'running');
    await transitionLifecycleStep(tenantId, operation.id, 'person', 'succeeded');
    await transitionLifecycleStep(tenantId, operation.id, 'targets', 'running');
    const completed = await transitionLifecycleStep(
      tenantId,
      operation.id,
      'targets',
      'succeeded',
    );

    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it('retries only failed and unfinished steps while preserving successful evidence', async () => {
    const operation = await createLifecycleOperation({
      tenantId,
      personId,
      kind: 'onboard',
      idempotencyKey: 'hire-HR-1045',
      input: {},
      steps: [
        { key: 'person', title: 'Save employee', required: true },
        { key: 'targets', title: 'Provision targets', required: true },
      ],
    });
    await transitionLifecycleStep(tenantId, operation.id, 'person', 'running');
    await transitionLifecycleStep(tenantId, operation.id, 'person', 'succeeded', {
      evidence: { personId },
    });
    await transitionLifecycleStep(tenantId, operation.id, 'targets', 'running');
    await transitionLifecycleStep(tenantId, operation.id, 'targets', 'failed', {
      message: 'Target unavailable',
    });

    const retried = await retryLifecycleOperation(tenantId, operation.id);

    expect(retried.attempt).toBe(2);
    expect(retried.status).toBe('queued');
    expect(retried.steps.find((step) => step.key === 'person')).toMatchObject({
      status: 'succeeded',
      evidence: { personId },
    });
    expect(retried.steps.find((step) => step.key === 'targets')).toMatchObject({
      status: 'pending',
      message: null,
    });
  });

  it('requires a complete divergent read-back before an ambiguous result is retried', async () => {
    const operation = await createLifecycleOperation({
      tenantId, personId, kind: 'onboard', idempotencyKey: 'hire-HR-1046', input: {},
      steps: [{ key: 'targets', title: 'Provision targets', required: true }],
    });
    await expect(assertRetryAfterVerification(tenantId, operation.id)).rejects.toThrow(/read-back/i);
    const step = operation.steps[0]!;
    await withTenant(tenantId, (tx) => tx.lifecycleObservation.create({
      data: {
        tenantId, stepId: step.id, completeness: 'complete', matches: false,
        expected: { accountPresent: true }, observed: { accountPresent: false },
        differences: [{ path: 'accountPresent' }],
      },
    }));
    await expect(assertRetryAfterVerification(tenantId, operation.id)).resolves.toBeUndefined();
  });
});
