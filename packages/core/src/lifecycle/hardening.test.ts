import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { recordEvent, verifyChain } from '../audit/audit-service.js';
import { renderMessage } from '../notify/notification-service.js';
import { TEMPLATES } from '../notify/templates/index.js';
import {
  approveLifecycleOperation,
  cancelLifecycleOperation,
  createLifecycleOperation,
  getLifecycleOperation,
  rejectLifecycleOperation,
  retryLifecycleOperation,
  transitionLifecycleStep,
  TARGET_STEP_KEY,
  LifecycleApprovalError,
  LifecycleApprovalRequiredError,
} from './operation-service.js';
import {
  approvalDecision,
  DEFAULT_LIFECYCLE_POLICY,
  getLifecyclePolicy,
  sloMinutesFor,
  updateLifecyclePolicy,
} from './policy.js';
import {
  lifecycleWorkMetrics,
  overdueReason,
  previewMover,
  queueLifecycleAlerts,
  recordSloBreaches,
} from './management.js';
import { runLifecycleSimulation } from './simulation-service.js';
import { runLifecycleRetention } from './retention.js';
import { placeLifecycleLegalHold, releaseLifecycleLegalHold } from './legal-hold.js';

let tenantId: string;
let requesterId: string;
let approverId: string;
let personId: string;

const tenantOnly = () => ({ tenantId });

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  await withTenant(tenantId, async (tx) => {
    requesterId = (await createUser(tx, { login: 'requester', email: 'requester@acme.test', displayName: 'Requester' })).id;
    approverId = (await createUser(tx, { login: 'approver', email: 'approver@acme.test', displayName: 'Approver' })).id;
    const person = await tx.person.create({ data: { tenantId, givenName: 'Maya', familyName: 'Okafor' } });
    personId = person.id;
    await tx.contract.create({
      data: { tenantId, personId, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01'), department: 'Finance', jobTitle: 'Analyst' },
    });
  });
});

const twoSteps = [
  { key: 'local', title: 'Save', required: true },
  { key: TARGET_STEP_KEY, title: 'Targets', required: true },
];

describe('attempt history', () => {
  it('appends a new attempt on retry and keeps the original evidence', async () => {
    const operation = await createLifecycleOperation({
      ...tenantOnly(), personId, kind: 'onboard', idempotencyKey: 'k1', input: {}, steps: twoSteps,
    });
    await transitionLifecycleStep(tenantId, operation.id, 'local', 'succeeded');
    await transitionLifecycleStep(tenantId, operation.id, TARGET_STEP_KEY, 'failed', {
      message: 'AD answered 503', responseCategory: 'transient', evidence: { attempt: 'one' },
    });
    const retried = await retryLifecycleOperation(tenantId, operation.id);
    expect(retried.attempt).toBe(2);
    await transitionLifecycleStep(tenantId, operation.id, TARGET_STEP_KEY, 'succeeded', {
      message: 'confirmed', responseCategory: 'confirmed',
    });
    const final = await getLifecycleOperation(tenantId, operation.id);
    const targets = final.steps.find((step) => step.key === TARGET_STEP_KEY)!;
    expect(targets.attempts.map((a) => [a.attempt, a.status, a.responseCategory, a.message])).toEqual([
      [1, 'failed', 'transient', 'AD answered 503'],
      [2, 'succeeded', 'confirmed', 'confirmed'],
    ]);
    // The first attempt's evidence survived the reset untouched.
    expect(targets.attempts[0]!.evidence).toEqual({ attempt: 'one' });
    expect(final.status).toBe('completed');
  });

  it('archives a step caught mid-flight as abandoned rather than losing it', async () => {
    const operation = await createLifecycleOperation({
      ...tenantOnly(), personId, kind: 'move', idempotencyKey: 'k2', input: {}, steps: twoSteps,
    });
    await transitionLifecycleStep(tenantId, operation.id, 'local', 'succeeded');
    await transitionLifecycleStep(tenantId, operation.id, TARGET_STEP_KEY, 'running');
    await retryLifecycleOperation(tenantId, operation.id);
    const after = await getLifecycleOperation(tenantId, operation.id);
    const targets = after.steps.find((step) => step.key === TARGET_STEP_KEY)!;
    expect(targets.status).toBe('pending');
    expect(targets.attempts.map((a) => a.status)).toEqual(['abandoned']);
  });
});

describe('approvals', () => {
  it('holds the target step until a different person approves', async () => {
    const operation = await createLifecycleOperation({
      ...tenantOnly(), personId, kind: 'onboard', idempotencyKey: 'k3', input: {}, steps: twoSteps,
      requestedByUserId: requesterId, approval: { required: true, reason: 'creates a target account' },
    });
    expect(operation.status).toBe('awaiting_approval');
    await transitionLifecycleStep(tenantId, operation.id, 'local', 'succeeded');
    await expect(
      transitionLifecycleStep(tenantId, operation.id, TARGET_STEP_KEY, 'running'),
    ).rejects.toBeInstanceOf(LifecycleApprovalRequiredError);
    await expect(retryLifecycleOperation(tenantId, operation.id)).rejects.toBeInstanceOf(LifecycleApprovalRequiredError);
    await expect(approveLifecycleOperation(tenantId, operation.id, requesterId)).rejects.toMatchObject({ code: 'four-eyes' });
    const approved = await approveLifecycleOperation(tenantId, operation.id, approverId);
    expect(approved.approvedByUserId).toBe(approverId);
    expect(approved.status).toBe('queued');
    await transitionLifecycleStep(tenantId, operation.id, TARGET_STEP_KEY, 'running');
    await expect(approveLifecycleOperation(tenantId, operation.id, approverId)).rejects.toBeInstanceOf(LifecycleApprovalError);
  });

  it('rejects an unapproved operation and skips what it would have done', async () => {
    const operation = await createLifecycleOperation({
      ...tenantOnly(), personId, kind: 'offboard', idempotencyKey: 'k4', input: {}, steps: twoSteps,
      requestedByUserId: requesterId, approval: { required: true, reason: 'urgent departure' },
    });
    const rejected = await rejectLifecycleOperation(tenantId, operation.id, approverId, 'not this person');
    expect(rejected.status).toBe('rejected');
    expect(rejected.steps.every((step) => step.status === 'skipped')).toBe(true);
    await expect(transitionLifecycleStep(tenantId, operation.id, 'local', 'running')).rejects.toThrow('rejected');
  });

  it('decides approval from policy', () => {
    const policy = { ...DEFAULT_LIFECYCLE_POLICY };
    expect(approvalDecision(policy, { kind: 'move', priority: 'normal', createsAccount: false, entitlementChanges: [] })).toEqual({ required: false, reason: null });
    const privileged = approvalDecision(policy, {
      kind: 'move', priority: 'normal', createsAccount: false,
      entitlementChanges: [{ displayName: 'Domain Admins', privileged: false }],
    });
    expect(privileged.required).toBe(true);
    expect(privileged.reason).toContain('Domain Admins');
    expect(approvalDecision(policy, { kind: 'bulk_retry', priority: 'normal', createsAccount: false, entitlementChanges: [], bulkCount: 10 }).required).toBe(true);
    expect(approvalDecision(policy, { kind: 'bulk_retry', priority: 'normal', createsAccount: false, entitlementChanges: [], bulkCount: 9 }).required).toBe(false);
    expect(approvalDecision({ ...policy, requireApprovalForUrgentDeparture: true }, { kind: 'offboard', priority: 'critical', createsAccount: false, entitlementChanges: [] }).required).toBe(true);
  });
});

describe('cancellation', () => {
  it('skips pending work, abandons running work and records the reason', async () => {
    const operation = await createLifecycleOperation({
      ...tenantOnly(), personId, kind: 'move', idempotencyKey: 'k5', input: {}, steps: twoSteps,
    });
    await transitionLifecycleStep(tenantId, operation.id, 'local', 'running');
    const cancelled = await cancelLifecycleOperation(tenantId, operation.id, approverId, 'wrong person');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.rejectionReason).toBe('wrong person');
    expect(cancelled.steps.map((step) => step.status)).toEqual(['failed', 'skipped']);
    expect(cancelled.steps[0]!.attempts.map((a) => a.status)).toEqual(['abandoned']);
  });
});

describe('policy and service levels', () => {
  it('returns defaults before anything is saved and persists an update', async () => {
    expect(await getLifecyclePolicy(tenantId)).toEqual(DEFAULT_LIFECYCLE_POLICY);
    const updated = await updateLifecyclePolicy(tenantId, { urgentLeaverSloMinutes: 10, escalationOwnerUserId: approverId }, requesterId);
    expect(updated.urgentLeaverSloMinutes).toBe(10);
    expect(updated.escalationOwnerUserId).toBe(approverId);
    expect((await getLifecyclePolicy(tenantId)).requireApprovalForPrivilegedGroups).toBe(true);
    await expect(updateLifecyclePolicy(tenantId, { auditRetentionDays: 30 }, requesterId)).rejects.toThrow();
  });

  it('fixes the deadline at creation and records breach and escalation from the clock', async () => {
    await updateLifecyclePolicy(tenantId, { escalationOwnerUserId: approverId }, requesterId);
    const policy = await getLifecyclePolicy(tenantId);
    expect(sloMinutesFor(policy, 'offboard', 'critical')).toBe(15);
    expect(sloMinutesFor(policy, 'offboard', 'normal')).toBe(24 * 60);
    const operation = await createLifecycleOperation({
      ...tenantOnly(), personId, kind: 'offboard', idempotencyKey: 'k6', input: {}, steps: twoSteps,
      priority: 'critical', sloMinutes: 15,
    });
    expect(operation.sloDeadlineAt!.getTime() - operation.createdAt.getTime()).toBe(15 * 60_000);
    const later = new Date(operation.createdAt.getTime() + 16 * 60_000);
    expect(overdueReason(operation, later)).toContain('service level of 15 minutes breached');
    const first = await recordSloBreaches(tenantId, later);
    expect(first).toEqual({ breached: 1, escalated: 1 });
    const after = await getLifecycleOperation(tenantId, operation.id);
    expect(after.sloBreachedAt).not.toBeNull();
    expect(after.escalatedToUserId).toBe(approverId);
    // Idempotent: the second pass neither re-breaches nor re-escalates.
    expect(await recordSloBreaches(tenantId, new Date(later.getTime() + 60_000))).toEqual({ breached: 0, escalated: 0 });
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany({ where: { requestId: operation.id } }));
    expect(outbox.map((row) => [row.template, row.to])).toEqual([['lifecycle-escalated', 'approver@acme.test']]);
    // Completing after the deadline keeps the breach on the record.
    await transitionLifecycleStep(tenantId, operation.id, 'local', 'succeeded');
    await transitionLifecycleStep(tenantId, operation.id, TARGET_STEP_KEY, 'succeeded');
    const done = await getLifecycleOperation(tenantId, operation.id);
    expect(done.status).toBe('completed');
    expect(done.sloBreachedAt).not.toBeNull();
    const metrics = await lifecycleWorkMetrics(tenantId, new Date(later.getTime() + 120_000));
    expect(metrics.sloBreachedResolved).toBe(1);
  });

  it('sends failed and overdue alerts to the owner or the escalation owner, with templates that render', async () => {
    await updateLifecyclePolicy(tenantId, { escalationOwnerUserId: approverId }, requesterId);
    const failed = await createLifecycleOperation({
      ...tenantOnly(), personId, kind: 'onboard', idempotencyKey: 'k7', input: {}, steps: twoSteps,
    });
    await transitionLifecycleStep(tenantId, failed.id, 'local', 'failed', { message: 'database refused', responseCategory: 'unavailable' });
    const blocked = await createLifecycleOperation({
      ...tenantOnly(), personId, kind: 'move', idempotencyKey: 'k8', input: {}, steps: twoSteps,
    });
    await transitionLifecycleStep(tenantId, blocked.id, 'local', 'succeeded');
    await transitionLifecycleStep(tenantId, blocked.id, TARGET_STEP_KEY, 'failed', {
      message: 'guard refused', responseCategory: 'blocked', evidence: { targetIds: [] },
    });
    const now = new Date();
    expect(await queueLifecycleAlerts(tenantId, now)).toBe(2);
    expect(await queueLifecycleAlerts(tenantId, now)).toBe(0);
    const rows = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany({ orderBy: { createdAt: 'asc' } }));
    expect(rows.map((row) => row.template).sort()).toEqual(['lifecycle-access-blocked', 'lifecycle-failed']);
    expect(rows.every((row) => row.digest === false)).toBe(true);
    for (const row of rows) {
      const message = renderMessage('Acme', row.template as keyof typeof TEMPLATES, row.to, row.vars as Record<string, string>);
      expect(message.subject).toContain('Maya Okafor');
      expect(message.text).toContain(`/admin/lifecycle-operations/${row.requestId}`);
    }
  });
});

describe('mover preview access and simulation', () => {
  async function targetWithRule() {
    return withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'AD', type: 'activeDirectory', config: { baseDn: 'DC=acme,DC=test', tlsMode: 'ldaps' }, secretName: 'ad', enabled: true },
      });
      await tx.accountProfile.create({
        data: {
          tenantId, targetSystemId: target.id, correlationKeyTemplate: '%person.givenName%.%person.familyName%',
          containerTemplate: 'OU=Staff,DC=acme,DC=test', fallbackContainer: 'OU=Staff,DC=acme,DC=test',
          attributeTemplates: { displayName: '%person.givenName% %person.familyName%' }, initialPasswordPolicy: {},
        },
      });
      const finance = await tx.entitlement.create({ data: { tenantId, targetSystemId: target.id, externalId: 'g-finance', type: 'group', displayName: 'Finance Share', status: 'present', lastSeenAt: new Date() } });
      const clinical = await tx.entitlement.create({ data: { tenantId, targetSystemId: target.id, externalId: 'g-clinical', type: 'group', displayName: 'Clinical Admins', status: 'present', lastSeenAt: new Date(), privileged: true } });
      const financeRule = await tx.businessRule.create({
        data: { tenantId, targetSystemId: target.id, name: 'Finance', condition: { op: 'equals', field: 'contract.department', value: 'Finance' }, grantsAccount: true, enabled: true },
      });
      await tx.ruleEntitlement.create({ data: { tenantId, ruleId: financeRule.id, entitlementId: finance.id } });
      const clinicalRule = await tx.businessRule.create({
        data: { tenantId, targetSystemId: target.id, name: 'Clinical', condition: { op: 'equals', field: 'contract.department', value: 'Clinical' }, grantsAccount: true, enabled: true },
      });
      await tx.ruleEntitlement.create({ data: { tenantId, ruleId: clinicalRule.id, entitlementId: clinical.id } });
      const account = await tx.targetAccount.create({
        data: { tenantId, targetSystemId: target.id, personId, anchor: 'guid-1', correlationKey: 'maya.okafor', status: 'active' },
      });
      await tx.accountEntitlement.create({ data: { tenantId, accountId: account.id, entitlementId: finance.id, state: 'held', origin: 'rule', grantedByRuleId: financeRule.id } });
      return { target, finance, clinical };
    });
  }

  it('shows the rule-derived additions, retentions and removals and asks for approval on a privileged change', async () => {
    const { finance, clinical } = await targetWithRule();
    const preview = await previewMover(tenantId, personId, 1, { department: 'Clinical' });
    expect(preview.changes).toEqual([{ field: 'department', before: 'Finance', after: 'Clinical' }]);
    expect(preview.access).toHaveLength(1);
    const delta = preview.access[0]!;
    expect(delta.account).toBe('keep');
    expect(delta.add.map((item) => item.entitlementId)).toEqual([clinical.id]);
    expect(delta.remove.map((item) => item.entitlementId)).toEqual([finance.id]);
    expect(delta.retain).toEqual([]);
    expect(delta.unverified).toBe(false);
    expect(preview.approval.required).toBe(true);
    expect(preview.approval.reason).toContain('Clinical Admins');
    expect(preview.sloMinutes).toBe(24 * 60);
  });

  it('rehearses joiner, mover and leaver for a department with no connector and stores the result', async () => {
    const { finance } = await targetWithRule();
    const hire = await runLifecycleSimulation(tenantId, { kind: 'hire', department: 'Finance' }, requesterId);
    expect(hire.writesPerformed).toBe(false);
    expect(hire.peopleCount).toBe(1);
    const hireResult = hire.result as { people: { targets: { account: string; retain: { entitlementId: string }[] }[] }[] };
    expect(hireResult.people[0]!.targets[0]!.account).toBe('keep');
    expect(hireResult.people[0]!.targets[0]!.retain.map((r) => r.entitlementId)).toEqual([finance.id]);
    const move = await runLifecycleSimulation(tenantId, { kind: 'move', department: 'Finance', changes: { department: 'Clinical' } }, requesterId);
    const moveResult = move.result as { people: { targets: { add: unknown[]; remove: unknown[] }[] }[] };
    expect(moveResult.people[0]!.targets[0]!.add).toHaveLength(1);
    expect(moveResult.people[0]!.targets[0]!.remove).toHaveLength(1);
    const leaver = await runLifecycleSimulation(tenantId, { kind: 'leaver', personId }, requesterId);
    const leaverResult = leaver.result as { people: { targets: { account: string; departure?: unknown }[]; syntraLogins: unknown[] }[] };
    expect(leaverResult.people[0]!.targets[0]!.account).toBe('disable');
    expect(leaverResult.people[0]!.targets[0]!.departure).toBeDefined();
    const stored = await withTenant(tenantId, (tx) => tx.lifecycleSimulation.count());
    expect(stored).toBe(3);
  });
});

describe('retention', () => {
  it('never prunes a resolved operation whose preservation hold is active', async () => {
    const operation = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'Held target', type: 'activeDirectory', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/held' },
      });
      const created = await tx.lifecycleOperation.create({
        data: {
          tenantId, personId, kind: 'onboard', idempotencyKey: 'held', status: 'completed', inputFingerprint: 'held', input: {},
          steps: { create: { tenantId, key: 'targets', title: 'Targets', position: 0, status: 'succeeded' } },
        }, include: { steps: true },
      });
      await tx.lifecycleObservation.create({
        data: { tenantId, stepId: created.steps[0]!.id, completeness: 'complete', matches: true, expected: {}, observed: {}, observedAt: new Date('2020-01-01') },
      });
      await tx.personProvisionReceipt.create({
        data: { tenantId, personId, targetSystemId: target.id, targetName: target.name, requestKey: created.id, status: 'applied', updatedAt: new Date('2020-01-01') },
      });
      await tx.notificationOutbox.create({
        data: { tenantId, requestId: created.id, template: 'lifecycle-failed', to: 'legal@acme.test', vars: {}, createdAt: new Date('2020-01-01'), sentAt: new Date('2020-01-01') },
      });
      return created;
    });
    const hold = await placeLifecycleLegalHold(tenantId, {
      subjectType: 'lifecycle_operation', subjectId: operation.id, reference: 'LEGAL-42',
      reason: 'Litigation preservation', actorUserId: requesterId,
    });
    const held = await runLifecycleRetention(tenantId, new Date('2030-01-01T00:00:00Z'));
    expect(held.lifecycleOperationsRemoved).toBe(0);
    await withTenant(tenantId, async (tx) => {
      await expect(tx.lifecycleOperation.findUnique({ where: { id: operation.id } })).resolves.not.toBeNull();
      expect(await tx.personProvisionReceipt.count({ where: { requestKey: operation.id } })).toBe(1);
      expect(await tx.lifecycleObservation.count({ where: { step: { operationId: operation.id } } })).toBe(1);
      expect(await tx.notificationOutbox.count({ where: { requestId: operation.id } })).toBe(1);
    });

    await releaseLifecycleLegalHold(tenantId, hold.id, requesterId);
    const released = await runLifecycleRetention(tenantId, new Date('2030-01-01T00:00:00Z'));
    expect(released.lifecycleOperationsRemoved).toBe(1);
    expect(released.receiptsRemoved).toBe(1);
    expect(released.notificationsRemoved).toBe(1);
  });

  it('removes only aged resolved evidence, keeps the audit chain verifiable, and records what it did', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await withTenant(tenantId, async (tx) => {
      const operation = await tx.lifecycleOperation.create({
        data: { tenantId, kind: 'onboard', idempotencyKey: 'old', status: 'completed', inputFingerprint: 'x', input: {}, steps: { create: [{ tenantId, key: 't', title: 't', position: 0, status: 'succeeded' }] } },
        include: { steps: true },
      });
      await tx.lifecycleObservation.create({
        data: { tenantId, stepId: operation.steps[0]!.id, completeness: 'complete', matches: true, expected: {}, observed: {}, observedAt: old },
      });
      const openOperation = await tx.lifecycleOperation.create({
        data: { tenantId, kind: 'onboard', idempotencyKey: 'open', status: 'running', inputFingerprint: 'y', input: {}, steps: { create: [{ tenantId, key: 't', title: 't', position: 0, status: 'running' }] } },
        include: { steps: true },
      });
      await tx.lifecycleObservation.create({
        data: { tenantId, stepId: openOperation.steps[0]!.id, completeness: 'complete', matches: false, expected: {}, observed: {}, observedAt: old },
      });
      await tx.notificationOutbox.create({ data: { tenantId, template: 'lifecycle-failed', to: 'a@b.test', vars: {}, sentAt: old, createdAt: old } });
      await tx.notificationOutbox.create({ data: { tenantId, template: 'lifecycle-failed', to: 'c@b.test', vars: {}, createdAt: old } });
      await tx.lifecycleSimulation.create({ data: { tenantId, kind: 'hire', scope: 'person', result: {}, createdAt: old } });
      for (let i = 0; i < 3; i += 1) {
        await recordEvent(tx, { actorUserId: null, action: `test.${i}`, targetType: 'Tenant', targetId: tenantId, outcome: 'success', sourceIp: null, payload: {} });
      }
      const second = await tx.auditEvent.findFirstOrThrow({ where: { sequence: 2 } });
      await tx.auditCheckpoint.create({ data: { tenantId, sequence: 2, hash: second.hash } });
    });
    await updateLifecyclePolicy(tenantId, { auditRetentionDays: 90 }, requesterId);
    // Audit rows cannot be back-dated (audit_no_update), so the clock moves
    // forward instead: a pass in 2030 with a 90-day policy makes today's
    // events eligible without touching them.
    const report = await runLifecycleRetention(tenantId, new Date('2030-01-01T00:00:00Z'));
    expect(report.observationsRemoved).toBe(1);
    expect(report.notificationsRemoved).toBe(1);
    expect(report.simulationsRemoved).toBe(1);
    // The completed operation is old enough to release its idempotency key;
    // the open one is deliberately retained as a retry receipt.
    expect(report.lifecycleOperationsRemoved).toBe(1);
    // Audit events are immutable to the application role: the pass counts
    // what is eligible for the database-owner archive procedure and removes
    // nothing itself.
    expect(report.auditEventsRemoved).toBe(0);
    expect(report.auditEventsEligible).toBe(2);
    expect(report.auditNote).toContain('checkpoint sequence 2');
    const remaining = await withTenant(tenantId, async (tx) => ({
      observations: await tx.lifecycleObservation.count(),
      operations: await tx.lifecycleOperation.count(),
      unsent: await tx.notificationOutbox.count({ where: { sentAt: null } }),
      chain: await verifyChain(tx),
      events: await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' }, select: { action: true } }),
    }));
    expect(remaining.observations).toBe(1);
    expect(remaining.operations).toBe(1);
    expect(remaining.unsent).toBe(1);
    expect(remaining.chain).toEqual({ valid: true });
    expect(remaining.events.map((event) => event.action)).toEqual(['test.0', 'test.1', 'test.2', 'lifecycle.retention.run']);
  });

  it('reports nothing eligible without a checkpoint', async () => {
    await updateLifecyclePolicy(tenantId, { auditRetentionDays: 90 }, requesterId);
    const report = await runLifecycleRetention(tenantId);
    expect(report.auditEventsEligible).toBe(0);
    expect(report.auditNote).toContain('no verified audit checkpoint');
  });

  it('verifies a chain that was pruned up to a checkpoint by the database owner', async () => {
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 3; i += 1) {
        await recordEvent(tx, { actorUserId: null, action: `test.${i}`, targetType: 'Tenant', targetId: tenantId, outcome: 'success', sourceIp: null, payload: {} });
      }
      const second = await tx.auditEvent.findFirstOrThrow({ where: { sequence: 2 } });
      await tx.auditCheckpoint.create({ data: { tenantId, sequence: 2, hash: second.hash } });
    });
    // The application role cannot delete; the owner procedure can. Stand in for it.
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE RULE audit_no_delete`);
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "sequence" <= 2`);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE RULE audit_no_delete`);
    }
    const chain = await withTenant(tenantId, (tx) => verifyChain(tx));
    expect(chain).toEqual({ valid: true });
  });
});
