import { createHash } from 'node:crypto';
import { Prisma, withTenant, type TenantClient } from '@syntra/db';
import {
  approvalGateOpen,
  createLifecycleOperation,
  getLifecycleOperation,
  retryLifecycleOperation,
  transitionLifecycleStep,
  TARGET_STEP_KEY,
  type LifecycleKind,
  type LifecycleOperationWithSteps,
} from './operation-service.js';
import { pruneExpiredLifecycleObservations } from './verification.js';
import {
  approvalDecision,
  readLifecyclePolicy,
  sloMinutesFor,
  type LifecyclePolicy,
} from './policy.js';
import { requestPersonProvision, retryPersonProvision } from '../provision/person-receipts.js';
import {
  accessDeltaFor,
  projectPersonOnTargets,
  type AccessDelta,
} from '../provision/desired-state-loader.js';
import { enqueueOutbox, usersWithPermission, type OutboxDraft } from '../automate/notify.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import type { Scheduler } from '../jobs/scheduler.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function configurationFingerprint(configuration: unknown): string {
  return createHash('sha256').update(canonical(configuration)).digest('hex');
}

/** Where a mail points. Relative when no public URL is configured, which a mail client still renders. */
export function lifecycleOperationUrl(operationId: string, publicUrl?: string): string {
  const base = (publicUrl ?? process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
  return `${base}/admin/lifecycle-operations/${operationId}`;
}

async function personName(tx: TenantClient, personId: string | null): Promise<string> {
  if (!personId) return 'an employee';
  const person = await tx.person.findFirst({
    where: { id: personId },
    select: { givenName: true, familyName: true },
  });
  return person ? `${person.givenName} ${person.familyName}` : 'an employee';
}

/**
 * Writes one lifecycle message per recipient, deduplicated on (template,
 * operation, recipient) while unsent, so a maintenance pass that runs every
 * hour does not mail somebody hourly about the same stuck operation.
 */
async function notifyLifecycle(
  tx: TenantClient,
  template: OutboxDraft['template'],
  operation: { id: string; kind: string; personId: string | null; priority: string },
  recipients: { userId: string; email: string; displayName: string }[],
  vars: Record<string, string>,
  options: { publicUrl?: string } = {},
): Promise<number> {
  if (recipients.length === 0) return 0;
  const already = await tx.notificationOutbox.findMany({
    where: { template, requestId: operation.id, sentAt: null, userId: { in: recipients.map((r) => r.userId) } },
    select: { userId: true },
  });
  const skip = new Set(already.map((row) => row.userId));
  const name = await personName(tx, operation.personId);
  const drafts: OutboxDraft[] = recipients
    .filter((recipient) => !skip.has(recipient.userId))
    .map((recipient) => ({
      template,
      to: recipient.email,
      userId: recipient.userId,
      requestId: operation.id,
      vars: {
        displayName: recipient.displayName,
        operationKind: operation.kind,
        personName: name,
        priority: operation.priority,
        operationUrl: lifecycleOperationUrl(operation.id, options.publicUrl),
        ...vars,
      },
    }));
  return enqueueOutbox(tx, drafts);
}

const moverFields = [
  'department',
  'jobTitle',
  'costCentre',
  'employer',
  'location',
  'managerPersonId',
  'fte',
] as const;
type MoverField = (typeof moverFields)[number];
export interface MoverChanges {
  department?: string | null;
  jobTitle?: string | null;
  costCentre?: string | null;
  employer?: string | null;
  location?: string | null;
  managerPersonId?: string | null;
  fte?: number | null;
}

export interface MoverPreview {
  tenantId: string;
  personId: string;
  contractSequence: number;
  revision: string;
  requested: MoverChanges;
  changes: { field: MoverField; before: string | number | null; after: string | number | null }[];
  contract: { startDate: string; endDate: string | null; isPrimary: boolean };
  manager: { before: string | null; after: string | null };
  /**
   * Per target: the account action and the entitlement additions, retentions
   * and removals the rules imply, computed with no connector opened. A target
   * whose catalog has not been confirmed is marked `unverified`, and a
   * removal on such a target is a possibility, not a promise.
   */
  access: AccessDelta[];
  approval: { required: boolean; reason: string | null };
  /** Minutes the policy allows for this change, or null. */
  sloMinutes: number | null;
}

async function moverRevision(tenantId: string, personId: string) {
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.findFirstOrThrow({
      where: { id: personId },
      include: { contracts: { orderBy: { sequence: 'asc' } } },
    });
    return configurationFingerprint({
      person: { id: person.id, updatedAt: person.updatedAt },
      contracts: person.contracts.map((contract) => ({
        id: contract.id,
        sequence: contract.sequence,
        startDate: contract.startDate,
        endDate: contract.endDate,
        department: contract.department,
        jobTitle: contract.jobTitle,
        costCentre: contract.costCentre,
        employer: contract.employer,
        location: contract.location,
        managerPersonId: contract.managerPersonId,
        fte: contract.fte,
      })),
    });
  });
}

async function displayNameOfPerson(tx: TenantClient, id: string | null) {
  if (!id) return null;
  const person = await tx.person.findFirst({ where: { id }, select: { givenName: true, familyName: true } });
  return person ? `${person.givenName} ${person.familyName}` : id;
}

export async function previewMover(
  tenantId: string,
  personId: string,
  contractSequence: number,
  requested: MoverChanges,
  options: { now?: Date } = {},
): Promise<MoverPreview> {
  const now = options.now ?? new Date();
  const { contract, policy, managerBefore, managerAfter } = await withTenant(tenantId, async (tx) => {
    const contract = await tx.contract.findFirstOrThrow({ where: { personId, sequence: contractSequence } });
    return {
      contract,
      policy: await readLifecyclePolicy(tx),
      managerBefore: await displayNameOfPerson(tx, contract.managerPersonId),
      managerAfter:
        requested.managerPersonId === undefined
          ? await displayNameOfPerson(tx, contract.managerPersonId)
          : await displayNameOfPerson(tx, requested.managerPersonId),
    };
  });
  const changes = moverFields.flatMap((field) => {
    if (!(field in requested)) return [];
    const rawBefore = contract[field];
    const before: string | number | null =
      rawBefore === null ? null : typeof rawBefore === 'string' ? rawBefore : Number(rawBefore);
    const after = requested[field] ?? null;
    return before === after ? [] : [{ field, before, after }];
  });
  const projections = await projectPersonOnTargets(tenantId, personId, {
    now,
    contractOverride: { sequence: contractSequence, ...requested },
  });
  const access = projections.map(accessDeltaFor);
  const approval = approvalDecision(policy, {
    kind: 'move',
    priority: 'normal',
    createsAccount: access.some((delta) => delta.account === 'create'),
    entitlementChanges: access.flatMap((delta) => [...delta.add, ...delta.remove]),
  });
  return {
    tenantId,
    personId,
    contractSequence,
    revision: await moverRevision(tenantId, personId),
    requested,
    changes,
    contract: {
      startDate: contract.startDate.toISOString(),
      endDate: contract.endDate?.toISOString() ?? null,
      isPrimary: contract.isPrimary,
    },
    manager: { before: managerBefore, after: managerAfter },
    access,
    approval,
    sloMinutes: sloMinutesFor(policy, 'move', 'normal'),
  };
}

/**
 * Queues the target work for an operation whose gate is open, and moves its
 * target step to match what the receipts say. Shared by every operation kind
 * and by the resume-after-approval path, so approval and first submission
 * cannot disagree about what "queue the targets" means.
 */
export async function queueTargetWork(
  tenantId: string,
  operationId: string,
  personId: string,
  scheduler: Scheduler,
  targetIds: string[],
) {
  if (targetIds.length === 0) {
    return transitionLifecycleStep(tenantId, operationId, TARGET_STEP_KEY, 'skipped', {
      message: 'No enabled target system is in scope for this operation.',
      responseCategory: 'no_change_required',
    });
  }
  const receipts = await requestPersonProvision(tenantId, personId, operationId, scheduler, targetIds);
  const evidence = {
    receiptIds: receipts.map((receipt) => receipt.id),
    targetIds,
  } as Prisma.InputJsonValue;
  if (receipts.some((receipt) => ['failed', 'blocked'].includes(receipt.status))) {
    return transitionLifecycleStep(tenantId, operationId, TARGET_STEP_KEY, 'failed', {
      message: 'One or more target operations failed or are blocked.',
      responseCategory: receipts.some((receipt) => receipt.status === 'blocked') ? 'blocked' : 'unavailable',
      evidence,
    });
  }
  if (receipts.every((receipt) => ['applied', 'no_match'].includes(receipt.status))) {
    return transitionLifecycleStep(tenantId, operationId, TARGET_STEP_KEY, 'succeeded', {
      message: 'All requested target operations reached their resolved state.',
      responseCategory: 'confirmed',
      evidence,
    });
  }
  await transitionLifecycleStep(tenantId, operationId, TARGET_STEP_KEY, 'running', { evidence });
  return withTenant(tenantId, (tx) =>
    tx.lifecycleOperation.update({
      where: { id: operationId },
      data: { status: 'waiting' },
      include: { steps: { orderBy: { position: 'asc' } } },
    }),
  );
}

export async function notifyLifecycleApprovers(
  tenantId: string,
  operation: LifecycleOperationWithSteps,
  requesterUserId: string | null,
  options: { publicUrl?: string } = {},
) {
  return withTenant(tenantId, async (tx) => {
    const approvers = (await usersWithPermission(tx, PERMISSIONS.PROVISION_MANAGE)).filter(
      (user) => user.userId !== requesterUserId,
    );
    const requester = requesterUserId
      ? await tx.user.findFirst({ where: { id: requesterUserId }, select: { displayName: true } })
      : null;
    return notifyLifecycle(
      tx,
      'lifecycle-approval-requested',
      operation,
      approvers,
      {
        requesterName: requester?.displayName ?? 'Somebody',
        reason: operation.approvalReason ?? '',
      },
      options,
    );
  });
}

export async function applyMover(
  tenantId: string,
  preview: MoverPreview,
  scheduler: Scheduler,
  actor: { userId: string | null; publicUrl?: string } = { userId: null },
) {
  if (preview.tenantId !== tenantId) throw new Error('Mover preview belongs to another tenant');
  if ((await moverRevision(tenantId, preview.personId)) !== preview.revision) {
    throw new Error('The employee changed since this preview. Review the changes again.');
  }
  // Policy is re-read at apply time: the preview's own claim about approval is
  // presentation, and a browser cannot be allowed to say "no approval needed".
  const { policy, live } = await withTenant(tenantId, async (tx) => ({
    policy: await readLifecyclePolicy(tx),
    live: null,
  }));
  void live;
  const access = (
    await projectPersonOnTargets(tenantId, preview.personId, {
      contractOverride: { sequence: preview.contractSequence, ...preview.requested },
    })
  ).map(accessDeltaFor);
  const approval = approvalDecision(policy, {
    kind: 'move',
    priority: 'normal',
    createsAccount: access.some((delta) => delta.account === 'create'),
    entitlementChanges: access.flatMap((delta) => [...delta.add, ...delta.remove]),
  });
  const operation = await createLifecycleOperation({
    tenantId,
    personId: preview.personId,
    kind: 'move',
    idempotencyKey: `move:${preview.personId}:${preview.revision}:${configurationFingerprint(preview.requested)}`,
    input: JSON.parse(
      JSON.stringify({
        contractSequence: preview.contractSequence,
        revision: preview.revision,
        requested: preview.requested,
        changes: preview.changes,
        access,
      }),
    ) as Prisma.InputJsonValue,
    steps: [
      { key: 'employee', title: 'Update employment details', required: true },
      { key: TARGET_STEP_KEY, title: 'Reconcile and verify target access', required: true },
    ],
    requestedByUserId: actor.userId,
    sloMinutes: sloMinutesFor(policy, 'move', 'normal'),
    approval,
  });
  await withTenant(tenantId, (tx) =>
    tx.contract.updateMany({
      where: { personId: preview.personId, sequence: preview.contractSequence },
      data: {
        ...(preview.requested.department === undefined ? {} : { department: preview.requested.department }),
        ...(preview.requested.jobTitle === undefined ? {} : { jobTitle: preview.requested.jobTitle }),
        ...(preview.requested.costCentre === undefined ? {} : { costCentre: preview.requested.costCentre }),
        ...(preview.requested.employer === undefined ? {} : { employer: preview.requested.employer }),
        ...(preview.requested.location === undefined ? {} : { location: preview.requested.location }),
        ...(preview.requested.managerPersonId === undefined ? {} : { managerPersonId: preview.requested.managerPersonId }),
        ...(preview.requested.fte === undefined ? {} : { fte: preview.requested.fte }),
      },
    }),
  );
  await transitionLifecycleStep(tenantId, operation.id, 'employee', 'succeeded', {
    evidence: { changes: preview.changes } as Prisma.InputJsonValue,
  });
  if (!approvalGateOpen(operation)) {
    // The employment record is updated -- that is HR's fact, not a target
    // write -- and the target work waits for a second person.
    await notifyLifecycleApprovers(tenantId, operation, actor.userId, actor);
    return getLifecycleOperation(tenantId, operation.id);
  }
  // Read the persisted target scope, rather than trusting the preview payload
  // returned by a browser.
  const targetIds = await withTenant(tenantId, (tx) =>
    tx.targetAccount.findMany({
      where: { personId: preview.personId },
      select: { targetSystemId: true },
    }).then((accounts) => [...new Set(accounts.map((account) => account.targetSystemId))]),
  );
  return queueTargetWork(tenantId, operation.id, preview.personId, scheduler, targetIds);
}

/**
 * After approval: perform the target work the gate was holding. Idempotent --
 * an operation whose target step is already past pending is returned as is.
 */
export async function resumeLifecycleOperation(
  tenantId: string,
  operationId: string,
  scheduler: Scheduler,
) {
  const operation = await getLifecycleOperation(tenantId, operationId);
  if (!approvalGateOpen(operation)) {
    throw new Error('This operation is still awaiting approval');
  }
  const targets = operation.steps.find((step) => step.key === TARGET_STEP_KEY);
  if (!targets || targets.status !== 'pending') return operation;
  if (operation.kind === 'bulk_retry') {
    const { operationIds } = operation.input as { operationIds: string[] };
    const results: { operationId: string; ok: boolean; status?: string; message?: string }[] = [];
    for (const id of operationIds) {
      try {
        const retried = await retryOperationWithReceipts(tenantId, id, scheduler);
        results.push({ operationId: id, ok: true, status: retried.status });
      } catch (error) {
        results.push({ operationId: id, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const failed = results.filter((result) => !result.ok).length;
    return transitionLifecycleStep(tenantId, operation.id, TARGET_STEP_KEY, failed === results.length && results.length > 0 ? 'failed' : 'succeeded', {
      message: `${results.length - failed} of ${results.length} operations were requeued.`,
      responseCategory: failed === results.length && results.length > 0 ? 'unavailable' : 'confirmed',
      evidence: { results } as Prisma.InputJsonValue,
    });
  }
  if (!operation.personId) return operation;
  const input = operation.input as { targetIds?: string[] | null };
  const targetIds =
    input.targetIds && input.targetIds.length > 0
      ? input.targetIds
      : await withTenant(tenantId, (tx) =>
          tx.targetAccount
            .findMany({ where: { personId: operation.personId! }, select: { targetSystemId: true } })
            .then((accounts) => [...new Set(accounts.map((account) => account.targetSystemId))]),
        );
  return queueTargetWork(tenantId, operation.id, operation.personId, scheduler, targetIds);
}

export interface ReadinessCheckInput {
  systemKind: 'source' | 'target';
  systemId: string;
  configuration: unknown;
  capabilities: string[];
  status: 'passed' | 'failed';
  latencyMs?: number;
  message?: string;
  actorUserId?: string;
}

export async function recordReadinessCheck(tenantId: string, input: ReadinessCheckInput) {
  return withTenant(tenantId, (tx) =>
    tx.connectionReadinessCheck.create({
      data: {
        tenantId,
        systemKind: input.systemKind,
        systemId: input.systemId,
        configurationFingerprint: configurationFingerprint(input.configuration),
        capabilities: input.capabilities,
        status: input.status,
        latencyMs: input.latencyMs ?? null,
        message: input.message ?? null,
        actorUserId: input.actorUserId ?? null,
      },
    }),
  );
}

export async function currentReadiness(
  tenantId: string,
  systemKind: 'source' | 'target',
  systemId: string,
  configuration: unknown,
) {
  const latest = await withTenant(tenantId, (tx) =>
    tx.connectionReadinessCheck.findFirst({
      where: { systemKind, systemId },
      orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
    }),
  );
  const fingerprint = configurationFingerprint(configuration);
  return latest
    ? { ...latest, current: latest.configurationFingerprint === fingerprint }
    : { current: false, status: 'untested' as const };
}

export async function assignLifecycleOperation(
  tenantId: string,
  operationId: string,
  ownerUserId: string,
  options: { priority: string; dueAt: Date | null; publicUrl?: string; actorUserId?: string | null },
) {
  return withTenant(tenantId, async (tx) => {
    const owner = await tx.user.findFirstOrThrow({ where: { id: ownerUserId } });
    const operation = await tx.lifecycleOperation.update({
      where: { id: operationId },
      data: {
        ownerUserId,
        priority: options.priority,
        dueAt: options.dueAt,
        acknowledgedAt: null,
      },
    });
    await tx.lifecycleCaseEvent.create({
      data: {
        tenantId,
        operationId,
        kind: 'assignment',
        actorUserId: options.actorUserId ?? null,
        metadata: { ownerUserId, priority: options.priority, dueAt: options.dueAt?.toISOString() ?? null },
      },
    });
    await notifyLifecycle(
      tx,
      'lifecycle-assigned',
      operation,
      [{ userId: owner.id, email: owner.email, displayName: owner.displayName }],
      { dueNote: options.dueAt ? `, due ${options.dueAt.toISOString()}` : '' },
      options,
    );
    return operation;
  });
}

export async function acknowledgeLifecycleOperation(tenantId: string, operationId: string, actorUserId?: string | null) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.update({
      where: { id: operationId },
      data: { acknowledgedAt: new Date() },
    });
    await tx.lifecycleCaseEvent.create({
      data: { tenantId, operationId, kind: 'acknowledgement', actorUserId: actorUserId ?? null },
    });
    return operation;
  });
}

/**
 * Why an operation counts as overdue, in a sentence an operator can act on,
 * or null when it is not. Computed from durable timestamps only.
 */
export function overdueReason(
  operation: {
    dueAt: Date | null;
    acknowledgedAt: Date | null;
    sloMinutes: number | null;
    sloDeadlineAt: Date | null;
    sloBreachedAt: Date | null;
    completedAt: Date | null;
    status: string;
  },
  now: Date = new Date(),
): string | null {
  const open = !['completed', 'cancelled', 'rejected'].includes(operation.status);
  const reasons: string[] = [];
  if (open && operation.dueAt && operation.dueAt < now && !operation.acknowledgedAt) {
    reasons.push(`past its due time (${operation.dueAt.toISOString()}) and not acknowledged`);
  }
  if (operation.sloDeadlineAt && operation.sloMinutes !== null) {
    const breachedAt = operation.sloBreachedAt ?? (open && operation.sloDeadlineAt < now ? now : null);
    if (breachedAt) {
      reasons.push(
        `service level of ${operation.sloMinutes} minutes breached at ${breachedAt.toISOString()}${
          operation.completedAt ? ' before completion' : ''
        }`,
      );
    }
  }
  return reasons.length === 0 ? null : reasons.join('; ');
}

/** The operation backlog, computed from the same durable states the queue uses. */
export async function lifecycleWorkMetrics(tenantId: string, now: Date = new Date()) {
  return withTenant(tenantId, async (tx) => {
    const unresolved = await tx.lifecycleOperation.findMany({
      where: { status: { notIn: ['completed', 'cancelled', 'rejected'] } },
      select: {
        status: true,
        createdAt: true,
        dueAt: true,
        acknowledgedAt: true,
        sloDeadlineAt: true,
        sloBreachedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const breachedResolved = await tx.lifecycleOperation.count({
      where: { status: 'completed', sloBreachedAt: { not: null } },
    });
    const oldest = unresolved[0]?.createdAt ?? null;
    return {
      running: unresolved.filter((operation) => operation.status === 'running').length,
      waiting: unresolved.filter((operation) => operation.status === 'waiting').length,
      failed: unresolved.filter((operation) => operation.status === 'failed').length,
      awaitingApproval: unresolved.filter((operation) => operation.status === 'awaiting_approval').length,
      overdue: unresolved.filter((operation) => operation.dueAt !== null && operation.dueAt < now && operation.acknowledgedAt === null).length,
      sloBreached: unresolved.filter(
        (operation) =>
          operation.sloBreachedAt !== null || (operation.sloDeadlineAt !== null && operation.sloDeadlineAt < now),
      ).length,
      sloBreachedResolved: breachedResolved,
      unresolved: unresolved.length,
      oldestUnresolvedAt: oldest,
      oldestUnresolvedAgeSeconds: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : null,
    };
  });
}

async function escalationOwner(tx: TenantClient, policy: LifecyclePolicy) {
  if (!policy.escalationOwnerUserId) return null;
  const user = await tx.user.findFirst({
    where: { id: policy.escalationOwnerUserId, status: 'active' },
    select: { id: true, email: true, displayName: true },
  });
  return user ? { userId: user.id, email: user.email, displayName: user.displayName } : null;
}

/**
 * Marks breached service levels from the clock and durable deadlines, and
 * escalates anything overdue or breached to the configured owner, once.
 */
export async function recordSloBreaches(
  tenantId: string,
  now: Date = new Date(),
  options: { publicUrl?: string } = {},
): Promise<{ breached: number; escalated: number }> {
  return withTenant(tenantId, async (tx) => {
    const policy = await readLifecyclePolicy(tx);
    const open = { status: { notIn: ['completed', 'cancelled', 'rejected'] } };
    const newlyBreached = await tx.lifecycleOperation.updateMany({
      where: { ...open, sloDeadlineAt: { lt: now }, sloBreachedAt: null },
      data: { sloBreachedAt: now },
    });
    const owner = await escalationOwner(tx, policy);
    let escalated = 0;
    if (owner) {
      const candidates = await tx.lifecycleOperation.findMany({
        where: {
          ...open,
          escalatedAt: null,
          OR: [
            { sloBreachedAt: { not: null } },
            { dueAt: { lt: now }, acknowledgedAt: null },
          ],
        },
        include: { steps: { orderBy: { position: 'asc' } } },
      });
      for (const operation of candidates) {
        const reason = overdueReason(operation, now) ?? 'overdue';
        await tx.lifecycleOperation.update({
          where: { id: operation.id },
          data: { escalatedAt: now, escalatedToUserId: owner.userId },
        });
        await tx.lifecycleCaseEvent.create({
          data: {
            tenantId,
            operationId: operation.id,
            kind: 'escalation',
            actorUserId: null,
            message: reason,
            metadata: { escalatedToUserId: owner.userId },
          },
        });
        const original = operation.ownerUserId
          ? await tx.user.findFirst({ where: { id: operation.ownerUserId }, select: { displayName: true } })
          : null;
        await notifyLifecycle(
          tx,
          'lifecycle-escalated',
          operation,
          [owner],
          { reason, ownerNote: original ? ` (${original.displayName})` : '' },
          options,
        );
        escalated += 1;
      }
    }
    return { breached: newlyBreached.count, escalated };
  });
}

/** Queue durable, deduplicated alerts for failed, overdue and blocked work, per policy. */
export async function queueLifecycleAlerts(
  tenantId: string,
  now: Date = new Date(),
  options: { publicUrl?: string } = {},
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const policy = await readLifecyclePolicy(tx);
    const fallback = await escalationOwner(tx, policy);
    const operations = await tx.lifecycleOperation.findMany({
      where: {
        status: { notIn: ['completed', 'cancelled', 'rejected'] },
        OR: [
          { status: 'failed' },
          { dueAt: { lt: now }, acknowledgedAt: null },
        ],
      },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    const owners = await tx.user.findMany({
      where: { id: { in: operations.flatMap((operation) => (operation.ownerUserId ? [operation.ownerUserId] : [])) } },
      select: { id: true, email: true, displayName: true },
    });
    const ownerById = new Map(owners.map((owner) => [owner.id, { userId: owner.id, email: owner.email, displayName: owner.displayName }]));
    let queued = 0;
    for (const operation of operations) {
      const recipient = (operation.ownerUserId ? ownerById.get(operation.ownerUserId) : undefined) ?? fallback;
      if (!recipient) continue;
      if (operation.status === 'failed' && policy.notifyOnFailure) {
        const failedStep = operation.steps.find((step) => step.status === 'failed');
        const blocked = failedStep?.responseCategory === 'blocked';
        if (blocked && policy.notifyOnAccessBlocked) {
          const evidence = (failedStep?.evidence ?? {}) as { targetIds?: string[] };
          const target = evidence.targetIds?.[0]
            ? await tx.targetSystem.findFirst({ where: { id: evidence.targetIds[0] }, select: { name: true } })
            : null;
          queued += await notifyLifecycle(tx, 'lifecycle-access-blocked', operation, [recipient], {
            targetName: target?.name ?? 'a target system',
            summary: failedStep?.message ?? 'blocked',
          }, options);
        } else {
          queued += await notifyLifecycle(tx, 'lifecycle-failed', operation, [recipient], {
            summary: failedStep?.message ?? 'a required step failed',
          }, options);
        }
      }
      if (operation.dueAt && operation.dueAt < now && !operation.acknowledgedAt && policy.notifyOnOverdue) {
        queued += await notifyLifecycle(tx, 'lifecycle-overdue', operation, [recipient], {
          dueAt: operation.dueAt.toISOString(),
          breachNote: operation.sloBreachedAt ? ` Its service level was breached at ${operation.sloBreachedAt.toISOString()}.` : '',
        }, options);
      }
    }
    return queued;
  });
}

/** Delivery records for one operation: what was queued, sent, or failed to send. */
export async function lifecycleNotifications(tenantId: string, operationId: string) {
  return withTenant(tenantId, (tx) =>
    tx.notificationOutbox.findMany({
      where: { requestId: operationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        template: true,
        to: true,
        userId: true,
        attempts: true,
        lastError: true,
        sentAt: true,
        digest: true,
        createdAt: true,
      },
    }),
  );
}

/** One idempotent maintenance pass, suitable for a recurring scheduler job. */
export async function maintainLifecycleOperations(
  tenantId: string,
  now: Date = new Date(),
  options: { publicUrl?: string } = {},
) {
  const breaches = await recordSloBreaches(tenantId, now, options);
  const [alertsQueued, observationsPruned] = await Promise.all([
    queueLifecycleAlerts(tenantId, now, options),
    pruneExpiredLifecycleObservations(tenantId, now),
  ]);
  return { ...breaches, alertsQueued, observationsPruned };
}

export type { LifecycleKind };

/**
 * Starts another attempt AND requeues the durable target receipts that
 * belong to it. Resetting a timeline without re-enqueueing its receipts
 * leaves an attractive but inert "Retry" button in the operator console.
 */
export async function retryOperationWithReceipts(
  tenantId: string,
  operationId: string,
  scheduler: Scheduler,
) {
  const operation = await getLifecycleOperation(tenantId, operationId);
  const receipts = operation.personId
    ? await withTenant(tenantId, (tx) =>
        tx.personProvisionReceipt.findMany({
          where: { personId: operation.personId!, requestKey: operation.id, status: { notIn: ['applied', 'no_match'] } },
          select: { id: true, personId: true },
        }),
      )
    : [];
  let updated = await retryLifecycleOperation(tenantId, operationId);
  if (receipts.length > 0) {
    const retried = await Promise.all(
      receipts.map((receipt) => retryPersonProvision(tenantId, receipt.personId, receipt.id, scheduler)),
    );
    const targetStep = updated.steps.find((step) => step.key === TARGET_STEP_KEY);
    if (targetStep && retried.some((receipt) => receipt.status === 'pending')) {
      updated = await transitionLifecycleStep(tenantId, operationId, TARGET_STEP_KEY, 'running', {
        message: 'Saved target receipts were requeued for execution and verification.',
        evidence: { receiptIds: retried.map((receipt) => receipt.id) },
      });
    }
  } else if (operation.kind === 'bulk_retry') {
    updated = (await resumeLifecycleOperation(tenantId, operationId, scheduler)) as typeof updated;
  }
  return updated;
}
