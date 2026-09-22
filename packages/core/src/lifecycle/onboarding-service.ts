import { Prisma, withTenant } from '@syntra/db';
import type { Scheduler } from '../jobs/scheduler.js';
import { createUser, type CreateUserInput } from '../directory/user-service.js';
import { createContract, type CreateContractInput } from '../identity/contract-service.js';
import { createPerson, linkUserToPerson, type CreatePersonInput } from '../identity/person-service.js';
import { enqueueOutbox, usersWithPermission } from '../automate/notify.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import {
  approvalGateOpen,
  createLifecycleOperation,
  getLifecycleOperation,
  transitionLifecycleStep,
  TARGET_STEP_KEY,
} from './operation-service.js';
import { lifecycleOperationUrl, queueTargetWork } from './management.js';
import { approvalDecision, readLifecyclePolicy, sloMinutesFor } from './policy.js';

export interface OnboardPersonInput {
  tenantId: string;
  idempotencyKey: string;
  person: CreatePersonInput;
  contract: CreateContractInput;
  login?: CreateUserInput | undefined;
  targetIds?: string[] | undefined;
  scheduler: Scheduler;
  requestedByUserId?: string | null;
  priority?: string;
  publicUrl?: string;
}

interface LocalEvidence {
  personId?: string;
  contractId?: string;
  userId?: string;
}

function jsonInput(input: OnboardPersonInput): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      person: input.person,
      contract: input.contract,
      login: input.login ?? null,
      targetIds: input.targetIds ?? null,
    }),
  ) as Prisma.InputJsonValue;
}

/**
 * Creates all local identity records in one transaction and then requests
 * target work through durable receipts. Replaying the key resumes the same
 * operation and cannot recreate a completed local step. When policy asks
 * for a second person before an account is created, the local records are
 * still saved -- they are HR's fact -- and the target step waits.
 */
export async function onboardPerson(input: OnboardPersonInput) {
  const policy = await withTenant(input.tenantId, readLifecyclePolicy);
  const priority = input.priority ?? 'normal';
  const approval = approvalDecision(policy, {
    kind: 'onboard',
    priority,
    // An onboarding that names a target is asking for an account there.
    createsAccount: (input.targetIds?.length ?? 0) > 0,
    entitlementChanges: [],
  });
  let operation = await createLifecycleOperation({
    tenantId: input.tenantId,
    kind: 'onboard',
    idempotencyKey: input.idempotencyKey,
    input: jsonInput(input),
    steps: [
      { key: 'local', title: 'Save employee, contract, and login', required: true },
      { key: TARGET_STEP_KEY, title: 'Provision and verify target access', required: true },
    ],
    requestedByUserId: input.requestedByUserId ?? null,
    priority,
    sloMinutes: sloMinutesFor(policy, 'onboard', priority),
    approval,
  });

  const local = operation.steps.find((step) => step.key === 'local')!;
  if (local.status !== 'succeeded') {
    try {
      await withTenant(input.tenantId, async (tx) => {
        const person = await createPerson(tx, input.person);
        const contract = await createContract(tx, person.id, input.contract);
        let userId: string | undefined;
        if (input.login) {
          const user = await createUser(tx, input.login);
          await linkUserToPerson(tx, user.id, person.id);
          userId = user.id;
        }
        const evidence: Prisma.InputJsonValue = {
          personId: person.id,
          contractId: contract.id,
          ...(userId ? { userId } : {}),
        };
        const now = new Date();
        await tx.lifecycleStep.update({
          where: { id: local.id },
          data: { status: 'succeeded', evidence, startedAt: now, completedAt: now },
        });
        await tx.lifecycleStepAttempt.create({
          data: {
            tenantId: input.tenantId,
            operationId: operation.id,
            stepId: local.id,
            stepKey: 'local',
            attempt: operation.attempt,
            status: 'succeeded',
            evidence,
            startedAt: now,
            completedAt: now,
          },
        });
        await tx.lifecycleOperation.update({
          where: { id: operation.id },
          data: {
            personId: person.id,
            status: approvalGateOpen(operation) ? 'running' : 'awaiting_approval',
            startedAt: now,
          },
        });
      });
      operation = await getLifecycleOperation(input.tenantId, operation.id);
    } catch (error) {
      await transitionLifecycleStep(input.tenantId, operation.id, 'local', 'failed', {
        message: error instanceof Error ? error.message : 'Local onboarding failed',
        responseCategory: 'unavailable',
      });
      throw error;
    }
  }

  const evidence = operation.steps.find((step) => step.key === 'local')!.evidence as LocalEvidence;
  const personId = evidence.personId ?? operation.personId;
  if (!personId) throw new Error('The onboarding operation has no saved person');

  const targetStep = operation.steps.find((step) => step.key === TARGET_STEP_KEY)!;
  if (!approvalGateOpen(operation)) {
    if (targetStep.status === 'pending') {
      await withTenant(input.tenantId, async (tx) => {
        const approvers = (await usersWithPermission(tx, PERMISSIONS.PROVISION_MANAGE)).filter(
          (user) => user.userId !== input.requestedByUserId,
        );
        const already = await tx.notificationOutbox.count({
          where: { template: 'lifecycle-approval-requested', requestId: operation.id },
        });
        if (already > 0 || approvers.length === 0) return;
        const requester = input.requestedByUserId
          ? await tx.user.findFirst({ where: { id: input.requestedByUserId }, select: { displayName: true } })
          : null;
        await enqueueOutbox(
          tx,
          approvers.map((approver) => ({
            template: 'lifecycle-approval-requested' as const,
            to: approver.email,
            userId: approver.userId,
            requestId: operation.id,
            vars: {
              displayName: approver.displayName,
              operationKind: 'onboard',
              personName: `${input.person.givenName} ${input.person.familyName}`,
              priority,
              requesterName: requester?.displayName ?? 'Somebody',
              reason: operation.approvalReason ?? '',
              operationUrl: lifecycleOperationUrl(operation.id, input.publicUrl),
            },
          })),
        );
      });
    }
  } else if (targetStep.status === 'pending' || targetStep.status === 'failed') {
    const targets = await withTenant(input.tenantId, (tx) =>
      tx.targetSystem.findMany({
        where: { enabled: true, ...(input.targetIds ? { id: { in: input.targetIds } } : {}) },
        select: { id: true },
      }),
    );
    operation = (await queueTargetWork(
      input.tenantId,
      operation.id,
      personId,
      input.scheduler,
      targets.map((target) => target.id),
    )) as typeof operation;
    operation = await getLifecycleOperation(input.tenantId, operation.id);
  }

  const person = await withTenant(input.tenantId, (tx) =>
    tx.person.findUniqueOrThrow({ where: { id: personId } }),
  );
  return { operation, person };
}
