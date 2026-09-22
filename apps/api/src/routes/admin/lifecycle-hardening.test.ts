import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignRole, createRole, createSession, createUser, PERMISSIONS } from '@syntra/core';
import { withTenant } from '@syntra/db';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let requester: { id: string; cookie: string };
let approver: { id: string; cookie: string };
let personId: string;

async function operator(login: string) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@test.test`, displayName: login });
    const role = await createRole(tx, `Lifecycle ${login}`, [
      PERMISSIONS.IDENTITY_READ,
      PERMISSIONS.IDENTITY_WRITE,
      PERMISSIONS.DIRECTORY_READ,
      PERMISSIONS.DIRECTORY_WRITE,
      PERMISSIONS.PROVISION_READ,
      PERMISSIONS.PROVISION_MANAGE,
    ]);
    await assignRole(tx, user.id, role.id);
    const session = await createSession(
      tx,
      { status: 'allow', userId: user.id, mayElevate: true, scope: 'admin', applicationId: null, satisfiedFactor: null },
      { ip: null, userAgent: null },
    );
    return { id: user.id, cookie: `syntra_session=${session.token}` };
  });
}

const send = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject(
    payload === undefined
      ? { method, url, headers: { host: ctx.host, cookie } }
      : { method, url, headers: { host: ctx.host, cookie }, payload: payload as object },
  );

beforeEach(async () => {
  ctx = await buildTestApp();
  requester = await operator('requester');
  approver = await operator('approver');
  personId = await withTenant(ctx.tenantId, async (tx) => {
    const person = await tx.person.create({ data: { tenantId: ctx.tenantId, givenName: 'Maya', familyName: 'Okafor' } });
    await tx.contract.create({
      data: { tenantId: ctx.tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01'), department: 'Finance' },
    });
    return person.id;
  });
});

afterEach(async () => ctx?.app.close());

describe('lifecycle policy', () => {
  it('reads defaults, saves an update, and refuses an unknown escalation owner', async () => {
    const defaults = await send('GET', '/api/admin/lifecycle-policy', requester.cookie);
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({ urgentLeaverSloMinutes: 15, requireApprovalForPrivilegedGroups: true });
    const saved = await send('PATCH', '/api/admin/lifecycle-policy', requester.cookie, { urgentLeaverSloMinutes: 10, escalationOwnerUserId: approver.id });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().urgentLeaverSloMinutes).toBe(10);
    const bad = await send('PATCH', '/api/admin/lifecycle-policy', requester.cookie, { escalationOwnerUserId: '00000000-0000-4000-8000-000000000000' });
    expect(bad.statusCode).toBe(400);
    const strict = await send('PATCH', '/api/admin/lifecycle-policy', requester.cookie, { unknownField: true });
    expect(strict.statusCode).toBe(400);
  });
});

describe('approvals over the API', () => {
  it('holds an onboarding that needs approval, refuses the requester, and runs after the approver signs', async () => {
    await send('PATCH', '/api/admin/lifecycle-policy', requester.cookie, { requireApprovalForAccountCreation: true });
    const targetId = await withTenant(ctx.tenantId, async (tx) =>
      (await tx.targetSystem.create({
        data: { tenantId: ctx.tenantId, name: 'AD', type: 'activeDirectory', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/ad', enabled: true },
      })).id,
    );
    const created = await send('POST', '/api/admin/lifecycle-operations/onboard', requester.cookie, {
      idempotencyKey: 'HR-2001',
      person: { givenName: 'Ana', familyName: 'Ruiz' },
      contract: { sequence: 1, isPrimary: true, startDate: '2026-10-01' },
      targetIds: [targetId],
    });
    expect(created.statusCode).toBe(201);
    const operationId: string = created.json().operation.id;
    expect(created.json().operation.status).toBe('awaiting_approval');
    // The local step ran: the employee exists even though the target waits.
    expect(created.json().person.givenName).toBe('Ana');
    // Approvers were told, and the requester was not.
    const outbox = await withTenant(ctx.tenantId, (tx) => tx.notificationOutbox.findMany({ where: { requestId: operationId } }));
    expect(outbox.map((row) => row.template)).toEqual(['lifecycle-approval-requested']);
    expect(outbox[0]!.to).toBe('approver@test.test');

    const listed = await send('GET', '/api/admin/lifecycle-operations?status=awaiting_approval', requester.cookie);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual([operationId]);

    const retry = await send('POST', `/api/admin/lifecycle-operations/${operationId}/retry`, requester.cookie);
    expect(retry.statusCode).toBe(409);
    const selfApprove = await send('POST', `/api/admin/lifecycle-operations/${operationId}/approve`, requester.cookie);
    expect(selfApprove.statusCode).toBe(403);
    const approved = await send('POST', `/api/admin/lifecycle-operations/${operationId}/approve`, approver.cookie);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().approvedByName).toBe('approver');
    expect(approved.json().requestedByName).toBe('requester');
    // No scheduler in the test app, so target work cannot be queued: the
    // step reports that honestly rather than pretending it ran.
    expect(['queued', 'failed', 'waiting', 'running']).toContain(approved.json().status);
    const again = await send('POST', `/api/admin/lifecycle-operations/${operationId}/approve`, approver.cookie);
    expect(again.statusCode).toBe(409);
  });

  it('rejects with a reason and cancels with a reason', async () => {
    await send('PATCH', '/api/admin/lifecycle-policy', requester.cookie, { requireApprovalForAccountCreation: true });
    const targetId = await withTenant(ctx.tenantId, async (tx) =>
      (await tx.targetSystem.create({
        data: { tenantId: ctx.tenantId, name: 'AD', type: 'activeDirectory', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/ad', enabled: true },
      })).id,
    );
    const created = await send('POST', '/api/admin/lifecycle-operations/onboard', requester.cookie, {
      idempotencyKey: 'HR-2002',
      person: { givenName: 'Ben', familyName: 'Osei' },
      contract: { sequence: 1, isPrimary: true, startDate: '2026-10-01' },
      targetIds: [targetId],
    });
    const operationId: string = created.json().operation.id;
    const noReason = await send('POST', `/api/admin/lifecycle-operations/${operationId}/reject`, approver.cookie, {});
    expect(noReason.statusCode).toBe(400);
    const rejected = await send('POST', `/api/admin/lifecycle-operations/${operationId}/reject`, approver.cookie, { reason: 'duplicate hire' });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe('rejected');

    const other = await withTenant(ctx.tenantId, (tx) =>
      tx.lifecycleOperation.create({
        data: {
          tenantId: ctx.tenantId, personId, kind: 'move', idempotencyKey: 'move-1', inputFingerprint: 'f', input: {}, status: 'running',
          steps: { create: [{ tenantId: ctx.tenantId, key: 'employee', title: 'Employee', position: 0, status: 'succeeded' }, { tenantId: ctx.tenantId, key: 'targets', title: 'Targets', position: 1, status: 'pending' }] },
        },
      }),
    );
    const cancelled = await send('POST', `/api/admin/lifecycle-operations/${other.id}/cancel`, requester.cookie, { reason: 'HR withdrew the change' });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect(cancelled.json().steps.map((step: { status: string }) => step.status)).toEqual(['succeeded', 'skipped']);
  });
});

describe('bulk actions', () => {
  async function failedOperation(key: string) {
    return withTenant(ctx.tenantId, (tx) =>
      tx.lifecycleOperation.create({
        data: {
          tenantId: ctx.tenantId, personId, kind: 'onboard', idempotencyKey: key, inputFingerprint: 'f', input: {}, status: 'failed',
          steps: { create: [{ tenantId: ctx.tenantId, key: 'local', title: 'Local', position: 0, status: 'failed', message: 'db' }] },
        },
      }),
    );
  }

  it('returns one result per operation and does not hide a refusal behind the others', async () => {
    const good = await failedOperation('bulk-1');
    const missing = '00000000-0000-4000-8000-000000000000';
    const response = await send('POST', '/api/admin/lifecycle-operations/bulk', requester.cookie, { action: 'acknowledge', operationIds: [good.id, missing] });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results.find((r: { operationId: string }) => r.operationId === good.id).ok).toBe(true);
    expect(body.results.find((r: { operationId: string }) => r.operationId === missing).ok).toBe(false);
  });

  it('turns a large requeue into an operation a second person must approve', async () => {
    await send('PATCH', '/api/admin/lifecycle-policy', requester.cookie, { bulkRequeueThreshold: 2 });
    const first = await failedOperation('bulk-2');
    const second = await failedOperation('bulk-3');
    const response = await send('POST', '/api/admin/lifecycle-operations/bulk', requester.cookie, { action: 'retry', operationIds: [first.id, second.id] });
    expect(response.statusCode).toBe(202);
    expect(response.json().approvalRequired).toBe(true);
    const bulkId: string = response.json().operationId;
    const read = await send('GET', `/api/admin/lifecycle-operations/${bulkId}`, requester.cookie);
    expect(read.json()).toMatchObject({ kind: 'bulk_retry', status: 'awaiting_approval' });
    // Nothing was retried yet.
    const untouched = await withTenant(ctx.tenantId, (tx) => tx.lifecycleOperation.findFirstOrThrow({ where: { id: first.id } }));
    expect(untouched.attempt).toBe(1);
    const approved = await send('POST', `/api/admin/lifecycle-operations/${bulkId}/approve`, approver.cookie);
    expect(approved.statusCode).toBe(200);
  });
});

describe('operation view and delivery records', () => {
  it('exposes attempts, the response category, the overdue reason and notification deliveries', async () => {
    const operation = await withTenant(ctx.tenantId, (tx) =>
      tx.lifecycleOperation.create({
        data: {
          tenantId: ctx.tenantId, personId, kind: 'offboard', idempotencyKey: 'view-1', inputFingerprint: 'f', input: {}, status: 'failed',
          priority: 'critical', sloMinutes: 15, sloDeadlineAt: new Date(Date.now() - 60_000), dueAt: new Date(Date.now() - 120_000),
          steps: { create: [{ tenantId: ctx.tenantId, key: 'targets', title: 'Targets', position: 0, status: 'failed', message: 'Graph refused', responseCategory: 'unauthorized' }] },
        },
      }),
    );
    await withTenant(ctx.tenantId, async (tx) => {
      const step = await tx.lifecycleStep.findFirstOrThrow({ where: { operationId: operation.id } });
      await tx.lifecycleStepAttempt.create({ data: { tenantId: ctx.tenantId, operationId: operation.id, stepId: step.id, stepKey: 'targets', attempt: 1, status: 'failed', responseCategory: 'unauthorized', message: 'Graph refused' } });
      await tx.notificationOutbox.create({ data: { tenantId: ctx.tenantId, template: 'lifecycle-failed', to: 'owner@test.test', vars: {}, requestId: operation.id, attempts: 2, lastError: 'smtp down' } });
    });
    const read = await send('GET', `/api/admin/lifecycle-operations/${operation.id}`, requester.cookie);
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.personName).toBe('Maya Okafor');
    expect(body.overdueReason).toContain('past its due time');
    expect(body.overdueReason).toContain('service level of 15 minutes breached');
    expect(body.steps[0].responseCategory).toBe('unauthorized');
    expect(body.steps[0].attempts).toHaveLength(1);
    const deliveries = await send('GET', `/api/admin/lifecycle-operations/${operation.id}/notifications`, requester.cookie);
    expect(deliveries.json().notifications).toMatchObject([{ template: 'lifecycle-failed', attempts: 2, lastError: 'smtp down', sentAt: null }]);
    const overdue = await send('GET', '/api/admin/lifecycle-operations?overdue=true', requester.cookie);
    expect(overdue.json().items.map((item: { id: string }) => item.id)).toEqual([operation.id]);
    const work = await send('GET', '/api/admin/employee-work', requester.cookie);
    const item = work.json().items.find((row: { id: string }) => row.id === `lifecycle:${operation.id}`);
    expect(item.overdue).toBe(true);
    expect(item.overdueReason).toContain('breached');
  });

  it('records a manual observation and leaves a mismatch for a person', async () => {
    const operation = await withTenant(ctx.tenantId, (tx) =>
      tx.lifecycleOperation.create({
        data: {
          tenantId: ctx.tenantId, personId, kind: 'onboard', idempotencyKey: 'obs-1', inputFingerprint: 'f', input: {}, status: 'waiting',
          steps: { create: [{ tenantId: ctx.tenantId, key: 'targets', title: 'Targets', position: 0, status: 'running' }] },
        },
      }),
    );
    const mismatch = await send('POST', `/api/admin/lifecycle-operations/${operation.id}/observations`, requester.cookie, {
      stepKey: 'targets',
      expected: { accountPresent: true, enabled: true, entitlements: ['erp'] },
      observed: { accountPresent: true, enabled: false, entitlements: ['erp'], complete: true },
    });
    expect(mismatch.statusCode).toBe(200);
    expect(mismatch.json().operation.steps[0].status).toBe('running');
    expect(mismatch.json().operation.steps[0].responseCategory).toBe('rejected');
    const confirmed = await send('POST', `/api/admin/lifecycle-operations/${operation.id}/observations`, requester.cookie, {
      stepKey: 'targets',
      expected: { accountPresent: true, enabled: true, entitlements: ['erp'] },
      observed: { accountPresent: true, enabled: false, entitlements: ['erp'], complete: true },
      manualConfirmation: true,
    });
    expect(confirmed.json().operation.steps[0].status).toBe('manual');
    expect(confirmed.json().operation.status).toBe('completed');
  });
});

describe('planned simulations', () => {
  it('rehearses a department without writes and lists the stored result', async () => {
    const run = await send('POST', '/api/admin/lifecycle-simulations', requester.cookie, { kind: 'leaver', department: 'Finance' });
    expect(run.statusCode).toBe(201);
    expect(run.json()).toMatchObject({ kind: 'leaver', scope: 'department', peopleCount: 1, writesPerformed: false });
    const both = await send('POST', '/api/admin/lifecycle-simulations', requester.cookie, { kind: 'hire', personId, department: 'Finance' });
    expect(both.statusCode).toBe(400);
    const list = await send('GET', '/api/admin/lifecycle-simulations', requester.cookie);
    expect(list.json().simulations).toHaveLength(1);
    const one = await send('GET', `/api/admin/lifecycle-simulations/${run.json().id}`, requester.cookie);
    expect(one.json().result.people[0].personName).toBe('Maya Okafor');
  });
});

describe('urgent departures', () => {
  it('applies the urgent service level and exposes the deadline', async () => {
    const preview = await send('GET', `/api/admin/persons/${personId}/offboarding`, requester.cookie);
    const ended = await send('POST', `/api/admin/persons/${personId}/offboarding`, requester.cookie, { reason: 'left', revision: preview.json().revision, urgent: true });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().priority).toBe('critical');
    const deadline = new Date(ended.json().sloDeadlineAt).getTime();
    expect(deadline - Date.now()).toBeGreaterThan(13 * 60_000);
    expect(deadline - Date.now()).toBeLessThan(16 * 60_000);
  });
});
