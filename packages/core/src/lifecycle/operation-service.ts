import { createHash } from 'node:crypto';
import { Prisma, withTenant, type TenantClient } from '@syntra/db';

export type LifecycleKind = 'onboard' | 'move' | 'offboard' | 'verify' | 'simulate' | 'bulk_retry';
export type LifecycleOperationStatus =
  | 'queued'
  | 'awaiting_approval'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';
export type LifecycleStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'manual'
  | 'skipped';

/**
 * How a target answered, in a closed vocabulary. `confirmed` is the only
 * value that means the target agreed; everything else names why it did not,
 * so an operator reading a timeline knows whether to wait, retry, fix a
 * credential, or go and look at the target by hand.
 */
export type TargetResponseCategory =
  | 'confirmed'
  | 'read_back_incomplete'
  | 'transient'
  | 'throttled'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'rejected'
  | 'blocked'
  | 'unavailable'
  | 'no_change_required';

export interface LifecycleStepInput {
  key: string;
  title: string;
  required: boolean;
}

/**
 * The step that reaches a target. Everything up to it is local record-keeping
 * and may run before approval; this one may not. Named once here so the
 * three operation kinds cannot spell it three ways.
 */
export const TARGET_STEP_KEY = 'targets';

export interface CreateLifecycleOperationInput {
  tenantId: string;
  personId?: string | null;
  kind: LifecycleKind;
  idempotencyKey: string;
  input: Prisma.InputJsonValue;
  steps: LifecycleStepInput[];
  requestedByUserId?: string | null;
  priority?: string;
  /** Minutes from creation to the service-level deadline; null for none. */
  sloMinutes?: number | null;
  approval?: { required: boolean; reason: string | null };
}

export const includeSteps = {
  steps: {
    orderBy: { position: 'asc' as const },
    include: {
      observations: { orderBy: { observedAt: 'desc' as const }, take: 1 },
      attempts: { orderBy: { recordedAt: 'asc' as const } },
    },
  },
};
export type LifecycleOperationWithSteps = Prisma.LifecycleOperationGetPayload<{
  include: typeof includeSteps;
}>;

const terminal = new Set<LifecycleStepStatus>(['succeeded', 'failed', 'manual', 'skipped']);
const resolved = new Set<LifecycleStepStatus>(['succeeded', 'manual', 'skipped']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function lifecycleInputFingerprint(input: unknown): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

export class LifecycleApprovalRequiredError extends Error {
  constructor(readonly operationId: string, readonly reason: string | null) {
    super(
      `This operation needs approval before it may change a target${reason ? `: ${reason}` : '.'}`,
    );
    this.name = 'LifecycleApprovalRequiredError';
  }
}

export class LifecycleApprovalError extends Error {
  constructor(message: string, readonly code: 'four-eyes' | 'not-pending' | 'already-decided') {
    super(message);
    this.name = 'LifecycleApprovalError';
  }
}

/**
 * An ambiguous target response is not a retry authorization. The operator
 * must first obtain a complete read-back that says the requested state is
 * still absent; otherwise a second write can duplicate an account or undo a
 * target-side success that simply had not reached Syntra yet.
 */
export class LifecycleVerificationRequiredError extends Error {
  constructor(readonly operationId: string, readonly reason: 'missing' | 'already-confirmed') {
    super(
      reason === 'missing'
        ? 'A complete target read-back is required before retrying this operation.'
        : 'Target state is already confirmed; retrying would repeat a completed write.',
    );
    this.name = 'LifecycleVerificationRequiredError';
  }
}

export async function createLifecycleOperation(input: CreateLifecycleOperationInput) {
  if (!input.idempotencyKey.trim()) throw new Error('An idempotency key is required');
  if (input.steps.length === 0) throw new Error('At least one lifecycle step is required');
  if (new Set(input.steps.map((step) => step.key)).size !== input.steps.length) {
    throw new Error('Lifecycle step keys must be unique');
  }
  const fingerprint = lifecycleInputFingerprint(input.input);
  return withTenant(input.tenantId, async (tx) => {
    const existing = await tx.lifecycleOperation.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: includeSteps,
    });
    if (existing) {
      // The key identifies a delivery, not merely a convenient label. Reusing
      // it with different data must never quietly resume an operation for the
      // wrong employee or contract.
      if (existing.inputFingerprint !== fingerprint) {
        throw new Error('This idempotency key was already used with different input');
      }
      return existing;
    }
    const now = new Date();
    const sloMinutes = input.sloMinutes ?? null;
    const approval = input.approval ?? { required: false, reason: null };
    return tx.lifecycleOperation.create({
      data: {
        tenantId: input.tenantId,
        personId: input.personId ?? null,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        input: input.input,
        inputFingerprint: fingerprint,
        priority: input.priority ?? 'normal',
        requestedByUserId: input.requestedByUserId ?? null,
        status: approval.required ? 'awaiting_approval' : 'queued',
        approvalRequired: approval.required,
        approvalReason: approval.reason,
        sloMinutes,
        // Fixed at creation from the clock, never recomputed: a policy edited
        // tomorrow does not move today's deadline.
        sloDeadlineAt: sloMinutes === null ? null : new Date(now.getTime() + sloMinutes * 60_000),
        createdAt: now,
        steps: {
          create: input.steps.map((step, position) => ({
            tenantId: input.tenantId,
            key: step.key,
            title: step.title,
            required: step.required,
            position,
          })),
        },
      },
      include: includeSteps,
    });
  });
}

export async function getLifecycleOperation(tenantId: string, operationId: string) {
  return withTenant(tenantId, (tx) =>
    tx.lifecycleOperation.findFirstOrThrow({
      where: { id: operationId },
      include: {
        ...includeSteps,
        caseEvents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    }),
  );
}

/** Whether the operation may still touch a target. */
export function approvalGateOpen(operation: {
  approvalRequired: boolean;
  approvedAt: Date | null;
  rejectedAt: Date | null;
}): boolean {
  if (operation.rejectedAt) return false;
  return !operation.approvalRequired || operation.approvedAt !== null;
}

/**
 * The operation-level status the steps imply, plus the two gates that sit
 * above the steps: a rejected operation stays rejected whatever its steps
 * say, and an unapproved one is waiting for a person, not for a target.
 */
function operationStatusFrom(
  operation: { approvalRequired: boolean; approvedAt: Date | null; rejectedAt: Date | null },
  steps: { required: boolean; status: string }[],
): LifecycleOperationStatus {
  if (operation.rejectedAt) return 'rejected';
  const required = steps.filter((candidate) => candidate.required);
  const complete = required.every((candidate) =>
    resolved.has(candidate.status as LifecycleStepStatus),
  );
  if (complete) return 'completed';
  if (required.some((candidate) => candidate.status === 'failed')) return 'failed';
  if (!approvalGateOpen(operation)) return 'awaiting_approval';
  return 'running';
}

async function recordAttempt(
  tx: TenantClient,
  tenantId: string,
  operation: { id: string; attempt: number },
  step: {
    id: string;
    key: string;
    status: string;
    message: string | null;
    evidence: Prisma.JsonValue | null;
    responseCategory: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  },
  override: { status?: string; completedAt?: Date } = {},
) {
  await tx.lifecycleStepAttempt.create({
    data: {
      tenantId,
      operationId: operation.id,
      stepId: step.id,
      stepKey: step.key,
      attempt: operation.attempt,
      status: override.status ?? step.status,
      message: step.message,
      evidence: step.evidence === null ? Prisma.JsonNull : (step.evidence as Prisma.InputJsonValue),
      responseCategory: step.responseCategory,
      startedAt: step.startedAt,
      completedAt: override.completedAt ?? step.completedAt,
    },
  });
}

export async function transitionLifecycleStep(
  tenantId: string,
  operationId: string,
  stepKey: string,
  status: LifecycleStepStatus,
  detail: {
    message?: string | null;
    evidence?: Prisma.InputJsonValue;
    responseCategory?: TargetResponseCategory | null;
    allowOutOfOrder?: boolean;
  } = {},
) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.findFirstOrThrow({
      where: { id: operationId },
      include: includeSteps,
    });
    const step = operation.steps.find((candidate) => candidate.key === stepKey);
    if (!step) throw new Error(`Unknown lifecycle step: ${stepKey}`);
    if (operation.rejectedAt) {
      throw new Error('This operation was rejected and cannot progress');
    }
    // The gate. A target step cannot start, and cannot be declared done,
    // while a person still has to sign for it. Failing or skipping it is
    // allowed: those record that nothing happened.
    if (
      step.key === TARGET_STEP_KEY &&
      (status === 'running' || status === 'succeeded') &&
      !approvalGateOpen(operation)
    ) {
      throw new LifecycleApprovalRequiredError(operation.id, operation.approvalReason);
    }
    if (status === 'running' && !detail.allowOutOfOrder) {
      const incompleteEarlier = operation.steps.some(
        (candidate) =>
          candidate.position < step.position &&
          candidate.required &&
          !resolved.has(candidate.status as LifecycleStepStatus),
      );
      if (incompleteEarlier) throw new Error('Complete earlier required steps first');
    }
    const now = new Date();
    const updated = await tx.lifecycleStep.update({
      where: { id: step.id },
      data: {
        status,
        ...(detail.message !== undefined ? { message: detail.message } : {}),
        ...(detail.evidence !== undefined ? { evidence: detail.evidence } : {}),
        ...(detail.responseCategory !== undefined
          ? { responseCategory: detail.responseCategory }
          : {}),
        ...(status === 'running' && !step.startedAt ? { startedAt: now } : {}),
        ...(terminal.has(status) ? { completedAt: now } : { completedAt: null }),
      },
    });
    // Append-only: a terminal outcome is written down as an attempt the
    // moment it happens, so a later retry that resets the step cannot take
    // the evidence with it.
    if (terminal.has(status)) {
      await recordAttempt(tx, tenantId, operation, updated);
    }
    const steps = await tx.lifecycleStep.findMany({
      where: { operationId },
      orderBy: { position: 'asc' },
    });
    const nextStatus = operationStatusFrom(operation, steps);
    const complete = nextStatus === 'completed';
    const breached =
      complete && operation.sloDeadlineAt !== null && now > operation.sloDeadlineAt
        ? (operation.sloBreachedAt ?? now)
        : operation.sloBreachedAt;
    return tx.lifecycleOperation.update({
      where: { id: operationId },
      data: {
        status: nextStatus,
        startedAt: operation.startedAt ?? now,
        completedAt: complete ? now : null,
        sloBreachedAt: breached,
      },
      include: includeSteps,
    });
  });
}

/**
 * Starts another attempt. The current state of every unfinished step is
 * archived first, so the history reads "attempt 1 failed because X; attempt
 * 2 …" rather than only ever showing the latest.
 */
export async function retryLifecycleOperation(tenantId: string, operationId: string) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.findFirstOrThrow({
      where: { id: operationId },
      include: includeSteps,
    });
    if (['completed', 'cancelled', 'rejected'].includes(operation.status)) return operation;
    if (!approvalGateOpen(operation)) {
      throw new LifecycleApprovalRequiredError(operation.id, operation.approvalReason);
    }
    const now = new Date();
    for (const step of operation.steps) {
      // Failed steps already wrote their attempt when they failed. A step
      // caught mid-flight has no row yet; it is archived as abandoned so the
      // gap in the history is visible rather than silent.
      if (step.status === 'running') {
        await recordAttempt(tx, tenantId, operation, step, {
          status: 'abandoned',
          completedAt: now,
        });
      }
    }
    await tx.lifecycleStep.updateMany({
      where: { operationId, status: { in: ['failed', 'pending', 'running'] } },
      data: {
        status: 'pending',
        message: null,
        responseCategory: null,
        startedAt: null,
        completedAt: null,
      },
    });
    return tx.lifecycleOperation.update({
      where: { id: operationId },
      data: {
        status: 'queued',
        attempt: { increment: 1 },
        startedAt: null,
        completedAt: null,
      },
      include: includeSteps,
    });
  });
}

/**
 * Guards the explicit "retry after verification" path. This is intentionally
 * separate from ordinary retry: ordinary transient failures remain retryable,
 * while an operator who calls this path has said the target result was
 * ambiguous and must bring fresh observed evidence with them.
 */
export async function assertRetryAfterVerification(
  tenantId: string,
  operationId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const latest = await tx.lifecycleObservation.findFirst({
      where: { step: { operationId } },
      orderBy: { observedAt: 'desc' },
      select: { completeness: true, matches: true },
    });
    if (!latest || latest.completeness !== 'complete') {
      throw new LifecycleVerificationRequiredError(operationId, 'missing');
    }
    if (latest.matches) {
      throw new LifecycleVerificationRequiredError(operationId, 'already-confirmed');
    }
  });
}

/**
 * A second person signs. The requester may not approve their own request;
 * that is the whole point of asking.
 */
export async function approveLifecycleOperation(
  tenantId: string,
  operationId: string,
  approverUserId: string,
) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.findFirstOrThrow({ where: { id: operationId } });
    if (!operation.approvalRequired) {
      throw new LifecycleApprovalError('This operation does not need approval', 'not-pending');
    }
    if (operation.approvedAt || operation.rejectedAt) {
      throw new LifecycleApprovalError('This operation was already decided', 'already-decided');
    }
    if (operation.requestedByUserId && operation.requestedByUserId === approverUserId) {
      throw new LifecycleApprovalError(
        'The person who requested an operation cannot approve it',
        'four-eyes',
      );
    }
    await tx.user.findFirstOrThrow({ where: { id: approverUserId } });
    const steps = await tx.lifecycleStep.findMany({ where: { operationId } });
    const approved = { ...operation, approvedAt: new Date(), approvedByUserId: approverUserId };
    return tx.lifecycleOperation.update({
      where: { id: operationId },
      data: {
        approvedAt: approved.approvedAt,
        approvedByUserId: approverUserId,
        status: operationStatusFrom(approved, steps) === 'running' ? 'queued' : operationStatusFrom(approved, steps),
      },
      include: includeSteps,
    });
  });
}

export async function rejectLifecycleOperation(
  tenantId: string,
  operationId: string,
  userId: string,
  reason: string,
) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.findFirstOrThrow({ where: { id: operationId } });
    if (!operation.approvalRequired) {
      throw new LifecycleApprovalError('This operation does not need approval', 'not-pending');
    }
    if (operation.approvedAt || operation.rejectedAt) {
      throw new LifecycleApprovalError('This operation was already decided', 'already-decided');
    }
    const now = new Date();
    await tx.lifecycleStep.updateMany({
      where: { operationId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'skipped',
        message: `Not performed: the operation was rejected (${reason})`,
        completedAt: now,
      },
    });
    return tx.lifecycleOperation.update({
      where: { id: operationId },
      data: {
        status: 'rejected',
        rejectedAt: now,
        rejectedByUserId: userId,
        rejectionReason: reason,
        completedAt: now,
      },
      include: includeSteps,
    });
  });
}

/**
 * Stops an operation that has not finished. Nothing at a target is undone --
 * there is no undo -- so what this records is that no further attempt will
 * be made and why. Pending steps are skipped with the reason; a step already
 * running keeps its state, because the write it started may have landed.
 */
export async function cancelLifecycleOperation(
  tenantId: string,
  operationId: string,
  userId: string,
  reason: string,
) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.findFirstOrThrow({ where: { id: operationId } });
    if (['completed', 'cancelled', 'rejected'].includes(operation.status)) return getLifecycleOperation(tenantId, operationId);
    const now = new Date();
    await tx.lifecycleStep.updateMany({
      where: { operationId, status: 'pending' },
      data: { status: 'skipped', message: `Not performed: the operation was cancelled (${reason})`, completedAt: now },
    });
    const running = await tx.lifecycleStep.findMany({ where: { operationId, status: 'running' } });
    for (const step of running) {
      await recordAttempt(tx, tenantId, operation, step, { status: 'abandoned', completedAt: now });
    }
    await tx.lifecycleStep.updateMany({
      where: { operationId, status: 'running' },
      data: { status: 'failed', message: `Abandoned: the operation was cancelled (${reason}). A write that was in flight may have landed; verify the target.`, responseCategory: 'unavailable', completedAt: now },
    });
    return tx.lifecycleOperation.update({
      where: { id: operationId },
      data: {
        status: 'cancelled',
        completedAt: now,
        rejectedAt: now,
        rejectedByUserId: userId,
        rejectionReason: reason,
      },
      include: includeSteps,
    });
  });
}
