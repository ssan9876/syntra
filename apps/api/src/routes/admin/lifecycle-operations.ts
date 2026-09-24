import type { FastifyInstance } from 'fastify';
import { Prisma, type TenantClient } from '@syntra/db';
import { z } from 'zod';
import {
  getLifecycleOperation,
  retryLifecycleOperation,
  assertRetryAfterVerification,
  approveLifecycleOperation,
  rejectLifecycleOperation,
  cancelLifecycleOperation,
  resumeLifecycleOperation,
  onboardPerson,
  IdempotencyKeyReusedError,
  applyMover,
  previewMover,
  simulateLifecycle,
  assignLifecycleOperation,
  acknowledgeLifecycleOperation,
  addLifecycleCaseNote,
  resolveLifecycleCase,
  reopenLifecycleCase,
  lifecycleResolutionCodes,
  LifecycleCaseStateError,
  lifecycleWorkMetrics,
  lifecycleNotifications,
  overdueReason,
  compareObservedState,
  recordLifecycleObservation,
  transitionLifecycleStep,
  retryOperationWithReceipts,
  getLifecyclePolicy,
  updateLifecyclePolicy,
  lifecyclePolicyUpdateSchema,
  approvalDecision,
  createLifecycleOperation,
  runLifecycleSimulation,
  listLifecycleSimulations,
  getLifecycleSimulation,
  LifecycleApprovalError,
  LifecycleApprovalRequiredError,
  LifecycleVerificationRequiredError,
  listLifecycleLegalHolds,
  placeLifecycleLegalHold,
  releaseLifecycleLegalHold,
  PERMISSIONS,
  TARGET_STEP_KEY,
  type Scheduler,
  type MoverChanges,
  type MoverPreview,
} from '@syntra/core';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { ProblemError } from '../../plugins/problem-json.js';
import { pageQuery } from './list-query.js';

export const idParams = z.object({ id: z.string().uuid() });
export const legalHoldRequest = z.object({
  subjectType: z.enum(['lifecycle_operation', 'lifecycle_simulation', 'person']),
  subjectId: z.string().uuid(),
  reference: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
}).strict();
export const legalHoldQuery = z.object({
  active: z.enum(['true', 'false']).default('true'),
  subjectType: z.enum(['lifecycle_operation', 'lifecycle_simulation', 'person']).optional(),
  subjectId: z.string().uuid().optional(),
}).refine((value) => !value.subjectId || value.subjectType, { message: 'subjectType is required with subjectId' });
const optionalText = z.string().trim().min(1).max(255).optional();
export const onboardingRequest = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  person: z.object({
    givenName: z.string().trim().min(1).max(100),
    familyName: z.string().trim().min(1).max(100),
    businessEmail: z.string().email().optional(),
    personalEmail: z.string().email().optional(),
    externalId: optionalText,
    orgUnitId: z.string().uuid().optional(),
  }),
  contract: z.object({
    sequence: z.number().int().positive().default(1),
    isPrimary: z.boolean().default(true),
    startDate: z.coerce.date(),
    endDate: z.coerce.date().optional(),
    jobTitle: optionalText,
    department: optionalText,
    costCentre: optionalText,
    employer: optionalText,
    location: optionalText,
    managerPersonId: z.string().uuid().optional(),
    fte: z.number().min(0).max(2).optional(),
  }),
  login: z
    .object({
      login: z.string().trim().min(1).max(200),
      email: z.string().email(),
      displayName: z.string().trim().min(1).max(200),
      orgUnitId: z.string().uuid().optional(),
    })
    .optional(),
  targetIds: z.array(z.string().uuid()).default([]),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
});
const moverChanges = z
  .object({
    department: z.string().nullable().optional(),
    jobTitle: z.string().nullable().optional(),
    costCentre: z.string().nullable().optional(),
    employer: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    managerPersonId: z.string().uuid().nullable().optional(),
    fte: z.number().min(0).max(2).nullable().optional(),
  })
  .strict()
  .transform((value) =>
    Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as MoverChanges,
  );
export const moverPreviewRequest = z.object({
  contractSequence: z.number().int().positive(),
  changes: moverChanges,
});
// Only what the server needs to re-derive the plan. Presentation fields
// (`access`, `approval`, `manager`) a browser sends back are ignored: the
// server recomputes them at apply time from the persisted state.
export const moverApplyRequest = z
  .object({
    tenantId: z.string().uuid(),
    personId: z.string().uuid(),
    contractSequence: z.number().int().positive(),
    revision: z.string().length(64),
    requested: moverChanges,
    changes: z.array(
      z.object({
        field: z.enum(['department', 'jobTitle', 'costCentre', 'employer', 'location', 'managerPersonId', 'fte']),
        before: z.union([z.string(), z.number(), z.null()]),
        after: z.union([z.string(), z.number(), z.null()]),
      }),
    ),
  })
  .passthrough();
export const simulationRequest = z.object({
  kind: z.enum(['hire', 'move', 'leaver']),
  current: z.object({
    accountPresent: z.boolean(),
    enabled: z.boolean(),
    entitlements: z.array(z.string()),
  }),
  desiredEntitlements: z.array(z.string()).default([]),
});
export const plannedSimulationRequest = z
  .object({
    kind: z.enum(['hire', 'move', 'leaver']),
    personId: z.string().uuid().optional(),
    department: z.string().trim().min(1).max(200).optional(),
    changes: moverChanges.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .refine((value) => (value.personId ? 1 : 0) + (value.department ? 1 : 0) === 1, {
    message: 'Name exactly one of personId or department',
  });
export const assignmentRequest = z.object({
  ownerUserId: z.string().uuid(),
  priority: z.enum(['low', 'normal', 'high', 'critical']),
  dueAt: z.coerce.date().nullable().default(null),
});
export const caseNoteRequest = z.object({ message: z.string().trim().min(1).max(4000) }).strict();
export const caseResolutionRequest = z.object({
  code: z.enum(lifecycleResolutionCodes),
  summary: z.string().trim().min(1).max(4000),
}).strict();
export const caseReopenRequest = z.object({ reason: z.string().trim().min(1).max(4000) }).strict();
export const bulkLifecycleRequest = z.object({
  operationIds: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['acknowledge', 'retry']),
});
export const decisionRequest = z.object({ reason: z.string().trim().min(1).max(1000) });
const targetState = z.object({
  accountPresent: z.boolean(),
  enabled: z.boolean(),
  attributes: z.record(z.string(), z.array(z.string())).default({}),
  entitlements: z.array(z.string()).default([]),
});
export const observationRequest = z.object({
  stepKey: z.string().trim().min(1).max(100),
  targetSystemId: z.string().uuid().optional(),
  expected: targetState,
  observed: targetState.extend({ complete: z.boolean() }),
  /** An operator who looked at the target and confirms the state by hand. */
  manualConfirmation: z.boolean().default(false),
});
export const listQuery = pageQuery.extend({
  status: z
    .enum(['queued', 'awaiting_approval', 'running', 'waiting', 'completed', 'failed', 'rejected', 'cancelled', 'open'])
    .optional(),
  kind: z.enum(['onboard', 'move', 'offboard', 'verify', 'simulate', 'bulk_retry']).optional(),
  ownerUserId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  overdue: z.literal('true').optional(),
  sort: z.enum(['updatedAt', 'createdAt', 'dueAt', 'sloDeadlineAt', 'priority']).default('updatedAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

const unavailableScheduler: Scheduler = {
  enqueue: async () => null,
  register: () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
} as unknown as Scheduler;

function translate(error: unknown): never {
  if (error instanceof ProblemError) throw error;
  if (error instanceof LifecycleApprovalRequiredError) {
    throw new ProblemError(409, 'approval-required', 'Approval required', error.message, {
      operationId: error.operationId,
      reason: error.reason,
    });
  }
  if (error instanceof LifecycleApprovalError) {
    throw new ProblemError(
      error.code === 'four-eyes' ? 403 : 409,
      `approval-${error.code}`,
      error.message,
    );
  }
  if (error instanceof LifecycleVerificationRequiredError) {
    throw new ProblemError(409, 'verification-required', 'Verification required', error.message, {
      operationId: error.operationId,
      reason: error.reason,
    });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    throw new ProblemError(404, 'not-found', 'Lifecycle operation not found');
  }
  if (error instanceof Error && /NotFound|not found|No LifecycleOperation/i.test(error.message)) {
    throw new ProblemError(404, 'not-found', 'Lifecycle operation not found');
  }
  throw error;
}

export async function registerAdminLifecycleOperationRoutes(
  app: FastifyInstance,
  options: { scheduler?: () => Scheduler | null; publicUrl?: string },
) {
  app.addHook('preHandler', requireSession('admin'));
  const actorOptions = (userId: string | null) => ({
    userId,
    ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
  });

  /** Names for the people an operation refers to, so a timeline reads as people rather than ids. */
  const decorate = async (
    tenantId: string,
    operation: Awaited<ReturnType<typeof getLifecycleOperation>>,
    db: <Result>(fn: (tx: TenantClient) => Promise<Result>) => Promise<Result>,
  ) => {
    const ids = [
      operation.ownerUserId,
      operation.requestedByUserId,
      operation.approvedByUserId,
      operation.rejectedByUserId,
      operation.escalatedToUserId,
      operation.resolvedByUserId,
      ...operation.caseEvents.map((event) => event.actorUserId),
    ].filter((id): id is string => id !== null);
    const [users, person] = await db(async (tx) => [
      ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, login: true } }) : [],
      operation.personId
        ? await tx.person.findFirst({ where: { id: operation.personId }, select: { givenName: true, familyName: true } })
        : null,
    ]);
    const nameOf = (id: string | null) => (id ? users.find((user) => user.id === id)?.displayName ?? null : null);
    void tenantId;
    return {
      ...operation,
      personName: person ? `${person.givenName} ${person.familyName}` : null,
      ownerName: nameOf(operation.ownerUserId),
      requestedByName: nameOf(operation.requestedByUserId),
      approvedByName: nameOf(operation.approvedByUserId),
      rejectedByName: nameOf(operation.rejectedByUserId),
      escalatedToName: nameOf(operation.escalatedToUserId),
      resolvedByName: nameOf(operation.resolvedByUserId),
      caseEvents: operation.caseEvents.map((event) => ({ ...event, actorName: nameOf(event.actorUserId) })),
      overdueReason: overdueReason(operation),
    };
  };

  const retryOperation = async (
    tenantId: string,
    operationId: string,
    db: <Result>(fn: (tx: TenantClient) => Promise<Result>) => Promise<Result>,
  ) => {
    // Keep the lifecycle operation and its durable target receipts in lockstep.
    // Resetting a timeline without re-enqueueing its receipts leaves an
    // attractive but inert "Retry" button in the operator console.
    const operation = await getLifecycleOperation(tenantId, operationId);
    const receipts = operation.personId
      ? await db((tx) => tx.personProvisionReceipt.findMany({
          where: { personId: operation.personId!, requestKey: operation.id, status: { notIn: ['applied', 'no_match'] } },
          select: { id: true, personId: true },
        }))
      : [];
    const scheduler = options.scheduler?.() ?? null;
    if (receipts.length > 0 && !scheduler) {
      throw new ProblemError(503, 'scheduler-unavailable', 'Background jobs are unavailable', 'Target receipts were not reset because they cannot be queued.');
    }
    if (!scheduler) return retryLifecycleOperation(tenantId, operationId);
    return retryOperationWithReceipts(tenantId, operationId, scheduler);
  };

  app.get(
    '/lifecycle-operations/metrics',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => lifecycleWorkMetrics(request.tenantId),
  );

  app.get(
    '/lifecycle-operations',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const query = listQuery.parse(request.query ?? {});
      const now = new Date();
      const where: Prisma.LifecycleOperationWhereInput = {
        ...(query.status === 'open'
          ? { status: { notIn: ['completed', 'cancelled', 'rejected'] } }
          : query.status
            ? { status: query.status }
            : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
        ...(query.personId ? { personId: query.personId } : {}),
        ...(query.overdue
          ? {
              status: { notIn: ['completed', 'cancelled', 'rejected'] },
              OR: [
                { dueAt: { lt: now }, acknowledgedAt: null },
                { sloDeadlineAt: { lt: now } },
              ],
            }
          : {}),
        ...(query.q
          ? {
              person: {
                OR: [
                  { givenName: { contains: query.q, mode: 'insensitive' } },
                  { familyName: { contains: query.q, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      };
      const orderBy: Prisma.LifecycleOperationOrderByWithRelationInput[] = [
        { [query.sort]: query.direction } as Prisma.LifecycleOperationOrderByWithRelationInput,
        { id: 'asc' },
      ];
      return request.db(async (tx) => {
        const [total, rows] = await Promise.all([
          tx.lifecycleOperation.count({ where }),
          tx.lifecycleOperation.findMany({
            where,
            orderBy,
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
            include: { person: { select: { givenName: true, familyName: true } } },
          }),
        ]);
        return {
          items: rows.map(({ person, input, ...operation }) => {
            void input;
            return {
              ...operation,
              personName: person ? `${person.givenName} ${person.familyName}` : null,
              overdueReason: overdueReason(operation, now),
            };
          }),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      });
    },
  );

  app.get(
    '/lifecycle-policy',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => getLifecyclePolicy(request.tenantId),
  );

  app.patch(
    '/lifecycle-policy',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const body = lifecyclePolicyUpdateSchema.parse(request.body ?? {});
      try {
        return await updateLifecyclePolicy(request.tenantId, body, request.session.userId);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          throw new ProblemError(400, 'invalid-owner', 'No such user', 'The escalation owner must be an existing account.');
        }
        throw error;
      }
    },
  );

  app.get(
    '/lifecycle-operations/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      try {
        return await decorate(request.tenantId, await getLifecycleOperation(request.tenantId, id), request.db);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.get(
    '/lifecycle-operations/:id/notifications',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return { notifications: await lifecycleNotifications(request.tenantId, id) };
    },
  );

  app.post(
    '/lifecycle-operations/:id/acknowledge',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      try {
        return await acknowledgeLifecycleOperation(request.tenantId, id, request.session.userId);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/:id/retry',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      try {
        return await retryOperation(request.tenantId, id, request.db);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/:id/case-notes',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { message } = caseNoteRequest.parse(request.body);
      try {
        return reply.code(201).send(await addLifecycleCaseNote(request.tenantId, id, request.session.userId, message));
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/:id/resolve',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = caseResolutionRequest.parse(request.body);
      try {
        return await resolveLifecycleCase(request.tenantId, id, request.session.userId, body.code, body.summary);
      } catch (error) {
        if (error instanceof LifecycleCaseStateError) {
          throw new ProblemError(409, 'case-state-conflict', 'Lifecycle case state conflict', error.message);
        }
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/:id/reopen',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { reason } = caseReopenRequest.parse(request.body);
      try {
        return await reopenLifecycleCase(request.tenantId, id, request.session.userId, reason);
      } catch (error) {
        if (error instanceof LifecycleCaseStateError) {
          throw new ProblemError(409, 'case-state-conflict', 'Lifecycle case state conflict', error.message);
        }
        translate(error);
      }
    },
  );

  app.get(
    '/lifecycle-legal-holds',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_READ) },
    async (request) => {
      const query = legalHoldQuery.parse(request.query ?? {});
      return {
        holds: await listLifecycleLegalHolds(request.tenantId, {
          activeOnly: query.active === 'true',
          ...(query.subjectType ? { subjectType: query.subjectType } : {}),
          ...(query.subjectId ? { subjectId: query.subjectId } : {}),
        }),
      };
    },
  );

  app.post(
    '/lifecycle-legal-holds',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const body = legalHoldRequest.parse(request.body);
      try {
        const hold = await placeLifecycleLegalHold(request.tenantId, { ...body, actorUserId: request.session.userId });
        return reply.code(201).send(hold);
      } catch (error) {
        if (error instanceof Error && error.message === 'Legal-hold subject not found') {
          throw new ProblemError(404, 'not-found', 'Legal-hold subject not found');
        }
        throw error;
      }
    },
  );

  app.post(
    '/lifecycle-legal-holds/:id/release',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      try {
        return await releaseLifecycleLegalHold(request.tenantId, id, request.session.userId);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/:id/retry-after-verification',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      try {
        await assertRetryAfterVerification(request.tenantId, id);
        return await retryOperation(request.tenantId, id, request.db);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/:id/approve',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      try {
        const approved = await approveLifecycleOperation(request.tenantId, id, request.session.userId);
        const scheduler = options.scheduler?.();
        // Approval opens the gate; the work still has to be queued. Without
        // a scheduler the operation stays queued and the console says so.
        const resumed = scheduler ? await resumeLifecycleOperation(request.tenantId, approved.id, scheduler) : approved;
        return await decorate(request.tenantId, await getLifecycleOperation(request.tenantId, resumed.id), request.db);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/:id/reject',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { reason } = decisionRequest.parse(request.body ?? {});
      try {
        return await rejectLifecycleOperation(request.tenantId, id, request.session.userId, reason);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/:id/cancel',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { reason } = decisionRequest.parse(request.body ?? {});
      try {
        return await cancelLifecycleOperation(request.tenantId, id, request.session.userId, reason);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/bulk',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const body = bulkLifecycleRequest.parse(request.body);
      const operationIds = [...new Set(body.operationIds)];
      if (body.action === 'retry') {
        const policy = await getLifecyclePolicy(request.tenantId);
        const decision = approvalDecision(policy, {
          kind: 'bulk_retry',
          priority: 'normal',
          createsAccount: false,
          entitlementChanges: [],
          bulkCount: operationIds.length,
        });
        if (decision.required) {
          // A large requeue becomes an operation of its own that a second
          // person approves; approving it performs every retry.
          const sorted = [...operationIds].sort();
          const operation = await createLifecycleOperation({
            tenantId: request.tenantId,
            kind: 'bulk_retry',
            idempotencyKey: `bulk-retry:${request.session.userId}:${sorted.join(',')}:${new Date().toISOString().slice(0, 16)}`,
            input: { operationIds: sorted },
            steps: [{ key: TARGET_STEP_KEY, title: `Requeue ${sorted.length} lifecycle operations`, required: true }],
            requestedByUserId: request.session.userId,
            approval: decision,
          });
          reply.code(202);
          return { action: body.action, approvalRequired: true, operationId: operation.id, reason: decision.reason, results: [] };
        }
      }
      // Every item gets its own result. One refusal must not hide the
      // outcome of the other ninety-nine, and a bulk action that claims
      // success for items it never reached is worse than no bulk action.
      const settled = await Promise.allSettled(
        operationIds.map((id) =>
          body.action === 'acknowledge'
            ? acknowledgeLifecycleOperation(request.tenantId, id, request.session.userId)
            : retryOperation(request.tenantId, id, request.db),
        ),
      );
      const results = settled.map((outcome, index) => {
        const id = operationIds[index]!;
        if (outcome.status === 'fulfilled') return { operationId: id, ok: true as const, status: outcome.value.status };
        const error = outcome.reason;
        const message =
          error instanceof ProblemError ? (error.detail ?? error.title) : error instanceof Error ? error.message : String(error);
        return { operationId: id, ok: false as const, message };
      });
      return {
        action: body.action,
        approvalRequired: false,
        results,
        operations: results.filter((r) => r.ok).map((r) => ({ id: r.operationId, status: r.status })),
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
    },
  );

  app.post(
    '/lifecycle-operations/:id/observations',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = observationRequest.parse(request.body);
      const operation = await getLifecycleOperation(request.tenantId, id).catch(translate);
      const step = operation.steps.find((candidate) => candidate.key === body.stepKey);
      if (!step) throw new ProblemError(404, 'not-found', 'Lifecycle step not found');
      const result = compareObservedState(body.expected, body.observed);
      const observation = await recordLifecycleObservation(
        request.tenantId,
        step.id,
        body.expected,
        body.observed,
        body.targetSystemId ? { targetSystemId: body.targetSystemId } : {},
      );
      const status = result.matches ? 'succeeded' : body.manualConfirmation && body.observed.complete ? 'manual' : 'running';
      try {
        const updated = await transitionLifecycleStep(request.tenantId, id, body.stepKey, status, {
          message: result.matches
            ? 'Observed target state matches the expected account and access.'
            : status === 'manual'
              ? 'An operator confirmed the target state by hand; the differences are recorded.'
              : body.observed.complete
                ? 'Observed target state does not match the expected account and access.'
                : 'Target read-back is incomplete. Manual verification is required.',
          responseCategory: result.matches ? 'confirmed' : body.observed.complete ? 'rejected' : 'read_back_incomplete',
          evidence: {
            observationId: observation.id,
            matches: result.matches,
            completeness: result.completeness,
            manualConfirmation: body.manualConfirmation,
            confirmedByUserId: body.manualConfirmation ? request.session.userId : null,
          },
        });
        return { observation, operation: updated, result };
      } catch (error) {
        translate(error);
      }
    },
  );

  app.patch(
    '/lifecycle-operations/:id/assignment',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = assignmentRequest.parse(request.body);
      try {
        return await assignLifecycleOperation(request.tenantId, id, body.ownerUserId, {
          priority: body.priority,
          dueAt: body.dueAt,
          ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
          actorUserId: request.session.userId,
        });
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/persons/:id/mover/preview',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = moverPreviewRequest.parse(request.body);
      try {
        return await previewMover(request.tenantId, id, body.contractSequence, body.changes);
      } catch (error) {
        translate(error);
      }
    },
  );

  app.post(
    '/persons/:id/mover/apply',
    {
      preHandler: [
        requirePermission(PERMISSIONS.IDENTITY_WRITE),
        requirePermission(PERMISSIONS.PROVISION_MANAGE),
      ],
    },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const preview = moverApplyRequest.parse(request.body);
      if (preview.personId !== id || preview.tenantId !== request.tenantId) {
        throw new ProblemError(409, 'stale-preview', 'Mover preview does not match this employee');
      }
      try {
        return await applyMover(
          request.tenantId,
          preview as unknown as MoverPreview,
          options.scheduler?.() ?? unavailableScheduler,
          actorOptions(request.session.userId),
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes('changed since this preview')) {
          throw new ProblemError(409, 'stale-preview', 'Employee changed since preview', error.message);
        }
        translate(error);
      }
    },
  );

  app.post(
    '/lifecycle-operations/simulate',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const body = simulationRequest.parse(request.body);
      return simulateLifecycle(body.kind, body.current, body.desiredEntitlements);
    },
  );

  app.post(
    '/lifecycle-simulations',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request, reply) => {
      const body = plannedSimulationRequest.parse(request.body);
      const simulation = await runLifecycleSimulation(
        request.tenantId,
        {
          kind: body.kind,
          ...(body.personId ? { personId: body.personId } : {}),
          ...(body.department ? { department: body.department } : {}),
          ...(body.changes ? { changes: body.changes } : {}),
          ...(body.limit ? { limit: body.limit } : {}),
        },
        request.session.userId,
      );
      reply.code(201);
      return simulation;
    },
  );

  app.get(
    '/lifecycle-simulations',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => ({ simulations: await listLifecycleSimulations(request.tenantId) }),
  );

  app.get(
    '/lifecycle-simulations/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      try {
        return await getLifecycleSimulation(request.tenantId, id);
      } catch {
        throw new ProblemError(404, 'not-found', 'Simulation not found');
      }
    },
  );

  app.post(
    '/lifecycle-operations/onboard',
    {
      preHandler: [
        requirePermission(PERMISSIONS.IDENTITY_WRITE),
        requirePermission(PERMISSIONS.DIRECTORY_WRITE),
        requirePermission(PERMISSIONS.PROVISION_MANAGE),
      ],
    },
    async (request, reply) => {
      const body = onboardingRequest.parse(request.body);
      const existed = await request.db((tx) =>
        tx.lifecycleOperation.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: request.tenantId,
              idempotencyKey: body.idempotencyKey,
            },
          },
          select: { id: true },
        }),
      );
      const result = await onboardPerson({
        tenantId: request.tenantId,
        idempotencyKey: body.idempotencyKey,
        person: body.person,
        contract: body.contract,
        ...(body.login ? { login: body.login } : {}),
        targetIds: body.targetIds,
        scheduler: options.scheduler?.() ?? unavailableScheduler,
        requestedByUserId: request.session.userId,
        priority: body.priority,
        ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      }).catch((cause: unknown) => {
        // The same key with different input is the CLIENT's error -- a replay
        // must never resume an operation for somebody else -- and it is
        // refused before anything is written. 409, with a stable type, rather
        // than the bare 500 an untranslated error becomes.
        if (cause instanceof IdempotencyKeyReusedError) {
          throw new ProblemError(
            409,
            'idempotency-key-reused',
            'Idempotency key already used',
            'This idempotencyKey was already used with different input. Use a new key for a new request.',
          );
        }
        throw cause;
      });
      reply.code(existed ? 200 : 201);
      return result;
    },
  );
}
