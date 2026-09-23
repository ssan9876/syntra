import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createLifecycleOperation, getLifecycleOperation } from './operation-service.js';
import {
  addLifecycleCaseNote,
  LifecycleCaseStateError,
  reopenLifecycleCase,
  resolveLifecycleCase,
} from './case-management.js';
import { acknowledgeLifecycleOperation, assignLifecycleOperation } from './management.js';

let tenantId: string;
let operatorId: string;
let operationId: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  operatorId = await withTenant(tenantId, async (tx) =>
    (await createUser(tx, { login: 'operator', email: 'operator@acme.test', displayName: 'Operator' })).id,
  );
  operationId = (await createLifecycleOperation({
    tenantId,
    kind: 'offboard',
    idempotencyKey: 'case-history',
    input: {},
    steps: [{ key: 'targets', title: 'Disable targets', required: true }],
  })).id;
});

describe('lifecycle case history', () => {
  it('keeps ownership, acknowledgement, notes, resolution and reopening as append-only events', async () => {
    const dueAt = new Date('2030-01-02T03:04:05.000Z');
    await assignLifecycleOperation(tenantId, operationId, operatorId, {
      priority: 'critical', dueAt, actorUserId: operatorId,
    });
    await acknowledgeLifecycleOperation(tenantId, operationId, operatorId);
    await addLifecycleCaseNote(tenantId, operationId, operatorId, 'Waiting for the directory owner.');
    await resolveLifecycleCase(tenantId, operationId, operatorId, 'manually_verified', 'Disabled in the target console.');

    await expect(
      resolveLifecycleCase(tenantId, operationId, operatorId, 'duplicate', 'Second close.'),
    ).rejects.toBeInstanceOf(LifecycleCaseStateError);

    await reopenLifecycleCase(tenantId, operationId, operatorId, 'New evidence shows the account is still enabled.');
    const operation = await getLifecycleOperation(tenantId, operationId);
    expect(operation).toMatchObject({
      ownerUserId: operatorId,
      priority: 'critical',
      dueAt,
      caseStatus: 'open',
      resolvedAt: null,
      resolutionCode: null,
    });
    expect(operation.caseEvents.map((event) => event.kind)).toEqual([
      'assignment', 'acknowledgement', 'note', 'resolution', 'reopened',
    ]);
    expect(operation.caseEvents[2]?.message).toBe('Waiting for the directory owner.');
  });
});
