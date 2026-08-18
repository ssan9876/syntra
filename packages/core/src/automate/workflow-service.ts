import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { listMembers } from '../directory/group-service.js';
import {
  resolveStageApprovers,
  type ApproverSelector,
  type DropReason,
  type SelectorConfig,
  type StageSnapshot,
} from './approvers.js';
import { automateSettings } from './catalog-service.js';

export class WorkflowConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowConfigurationError';
  }
}

export type StageInput = StageSnapshot;

export interface WorkflowInput {
  name: string;
  description: string | null;
  enabled: boolean;
  /** An EMPTY list is the auto-grant mechanism. Not a flag, not a special case. */
  stages: StageInput[];
}

const SELECTORS_NEEDING_FALLBACK: ApproverSelector[] = [
  'manager',
  'managerChain',
  'resourceOwner',
];

function requiredConfigKey(selector: ApproverSelector): keyof SelectorConfig | null {
  if (selector === 'role') return 'roleId';
  if (selector === 'group') return 'groupId';
  if (selector === 'person') return 'personId';
  return null;
}

/**
 * The largest number of people a selector could resolve to, for the `all`
 * quorum check.
 *
 * `manager`, `managerChain` and `person` are one by construction.
 * `productOwner` and `resourceOwner` depend on the product and the request and
 * cannot be counted at save time, so they are treated as one -- the honest
 * answer, since the alternative is refusing every `all` stage that uses them.
 */
async function upperBoundOnApprovers(
  tx: TenantClient,
  selector: ApproverSelector,
  config: SelectorConfig,
): Promise<number> {
  if (selector === 'group' && config.groupId !== undefined) {
    return (await listMembers(tx, config.groupId)).length;
  }
  if (selector === 'role' && config.roleId !== undefined) {
    return tx.roleAssignment.count({ where: { roleId: config.roleId } });
  }
  return 1;
}

async function validateStages(
  tx: TenantClient,
  stages: StageInput[],
  maxApprovers: number,
): Promise<void> {
  const sequences = stages.map((s) => s.sequence);
  const expected = stages.map((_, index) => index + 1);
  if (JSON.stringify([...sequences].sort((a, b) => a - b)) !== JSON.stringify(expected)) {
    throw new WorkflowConfigurationError(
      'sequence-gap',
      'Stages are numbered from one with no gaps and no duplicates; the request walks them in order.',
    );
  }

  for (const stage of stages) {
    if (
      SELECTORS_NEEDING_FALLBACK.includes(stage.selector) &&
      stage.fallbackSelector === null
    ) {
      throw new WorkflowConfigurationError(
        'fallback-required',
        `Stage ${stage.sequence} uses ${stage.selector}, which legitimately resolves to nobody — a person with no manager, a chain shorter than n, a resource whose owner was never recorded. Name a fallback approver.`,
      );
    }

    if (stage.selector === 'managerChain') {
      const depth = stage.selectorConfig.depth;
      if (depth === undefined || !Number.isInteger(depth) || depth < 1 || depth > 5) {
        throw new WorkflowConfigurationError(
          'chain-depth',
          `Stage ${stage.sequence} asks for manager level ${String(depth)}; choose between 1 and 5.`,
        );
      }
    }

    for (const [selector, config, label] of [
      [stage.selector, stage.selectorConfig, 'approver'],
      ...(stage.fallbackSelector === null
        ? []
        : ([[stage.fallbackSelector, stage.fallbackConfig, 'fallback']] as const)),
      ...(stage.escalationSelector === null
        ? []
        : ([[stage.escalationSelector, stage.escalationConfig, 'escalation']] as const)),
    ] as [ApproverSelector, SelectorConfig, string][]) {
      const key = requiredConfigKey(selector);
      if (key !== null && config[key] === undefined) {
        throw new WorkflowConfigurationError(
          'selector-config-missing',
          `Stage ${stage.sequence}: the ${label} uses ${selector} but names no ${key}.`,
        );
      }
    }

    if (stage.onTimeout === 'expire' && stage.expiryHours === null) {
      throw new WorkflowConfigurationError(
        'expiry-hours-required',
        `Stage ${stage.sequence} expires requests, so it needs an expiry window.`,
      );
    }
    if (stage.onTimeout === 'escalate' && stage.escalationSelector === null) {
      throw new WorkflowConfigurationError(
        'escalation-required',
        `Stage ${stage.sequence} escalates, so it needs somebody to escalate to.`,
      );
    }
    if (!Number.isInteger(stage.slaHours) || stage.slaHours <= 0) {
      throw new WorkflowConfigurationError(
        'sla-invalid',
        `Stage ${stage.sequence} needs a service level of at least one hour.`,
      );
    }

    if (stage.quorum === 'all') {
      const bound = await upperBoundOnApprovers(tx, stage.selector, stage.selectorConfig);
      if (bound > maxApprovers) {
        throw new WorkflowConfigurationError(
          'quorum-too-large',
          `Stage ${stage.sequence} would need all ${bound} approvers to agree, and this tenant allows at most ${maxApprovers}. A stage that cannot complete is a request that sits forever.`,
        );
      }
    }
  }
}

export async function upsertWorkflow(
  tenantId: string,
  actorUserId: string | null,
  workflowId: string | null,
  input: WorkflowInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);
    await validateStages(tx, input.stages, settings.maxApprovers);

    const previous =
      workflowId === null
        ? null
        : await tx.approvalWorkflow.findUnique({
            where: { id: workflowId },
            include: { stages: true },
          });

    const workflow =
      previous === null
        ? await tx.approvalWorkflow.create({
            data: {
              tenantId,
              name: input.name,
              description: input.description,
              enabled: input.enabled,
            },
          })
        : await tx.approvalWorkflow.update({
            where: { id: previous.id },
            data: {
              name: input.name,
              description: input.description,
              enabled: input.enabled,
            },
          });

    // Replaced whole rather than merged. A stage list edited by patch has no
    // readable diff and no defensible answer to "which stage is stage 2 now".
    await tx.approvalStage.deleteMany({ where: { workflowId: workflow.id } });
    if (input.stages.length > 0) {
      await tx.approvalStage.createMany({
        data: input.stages.map((stage) => ({
          tenantId,
          workflowId: workflow.id,
          sequence: stage.sequence,
          name: stage.name,
          selector: stage.selector,
          // `as never` on all three: `SelectorConfig` is an `interface`, and
          // TypeScript gives an implicit index signature to object type
          // literals and type aliases but NEVER to an interface, so it is not
          // assignable to `Prisma.InputJsonValue`. Global Constraint 21; the
          // repository's convention is `sync/source-service.ts:41`.
          selectorConfig: stage.selectorConfig as never,
          quorum: stage.quorum,
          fallbackSelector: stage.fallbackSelector,
          fallbackConfig: stage.fallbackConfig as never,
          slaHours: stage.slaHours,
          onTimeout: stage.onTimeout,
          escalationSelector: stage.escalationSelector,
          escalationConfig: stage.escalationConfig as never,
          expiryHours: stage.expiryHours,
        })),
      });
    }

    await recordEvent(tx, {
      actorUserId,
      action: 'automate.workflow.upsert',
      targetType: 'ApprovalWorkflow',
      targetId: workflow.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        name: input.name,
        enabled: input.enabled,
        previousStageCount: previous?.stages.length ?? null,
        stageCount: input.stages.length,
        // Said in the record, not inferred by a reader counting stages. A
        // workflow at zero stages grants everything it is attached to, and
        // that fact has to be legible a year later.
        grantsImmediately: input.stages.length === 0,
        stages: input.stages.map((s) => ({
          sequence: s.sequence,
          selector: s.selector,
          quorum: s.quorum,
          onTimeout: s.onTimeout,
        })),
      },
    });

    return { id: workflow.id };
  });
}

/**
 * The stages, in order, as the value type the resolver and the request
 * snapshot both speak. JSON columns come back as `unknown`, and the casts here
 * are the one place that conversion happens.
 */
export async function loadWorkflowStages(
  tx: TenantClient,
  workflowId: string,
): Promise<StageSnapshot[]> {
  const rows = await tx.approvalStage.findMany({
    where: { workflowId },
    orderBy: { sequence: 'asc' },
  });
  return rows.map((row) => ({
    sequence: row.sequence,
    name: row.name,
    selector: row.selector as ApproverSelector,
    selectorConfig: (row.selectorConfig ?? {}) as SelectorConfig,
    quorum: row.quorum as 'any' | 'all',
    fallbackSelector: row.fallbackSelector as ApproverSelector | null,
    fallbackConfig: (row.fallbackConfig ?? {}) as SelectorConfig,
    slaHours: row.slaHours,
    onTimeout: row.onTimeout as 'remind' | 'escalate' | 'expire',
    escalationSelector: row.escalationSelector as ApproverSelector | null,
    escalationConfig: (row.escalationConfig ?? {}) as SelectorConfig,
    expiryHours: row.expiryHours,
  }));
}

export interface StagePreview {
  sequence: number;
  name: string;
  selector: ApproverSelector;
  quorum: 'any' | 'all';
  usedFallback: boolean;
  approvers: { personId: string; displayName: string; via: string }[];
  dropped: { personId: string; displayName: string; reason: DropReason }[];
  blocked: boolean;
}

/**
 * "Pick a real person, see the chain this workflow produces for them."
 *
 * The screen that catches a workflow resolving to nobody, a fallback that is
 * missing, and a stage where the subject is the only approver -- before it is
 * saved rather than at 3am on somebody's request.
 *
 * The subject is the submitter here, which is the ordinary case and also the
 * strictest: it exercises both halves of the subtraction.
 */
export async function previewWorkflowResolution(
  tenantId: string,
  workflowId: string,
  subjectPersonId: string,
  productId: string | null,
  on: Date = new Date(),
): Promise<StagePreview[]> {
  return withTenant(tenantId, async (tx) => {
    const stages = await loadWorkflowStages(tx, workflowId);
    const product =
      productId === null
        ? null
        : await tx.product.findUnique({
            where: { id: productId },
            include: { grants: true },
          });

    const subject = {
      subjectPersonId,
      submitterPersonId: subjectPersonId,
      productOwnerPersonId: product?.ownerPersonId ?? null,
      productOwnerGroupId: product?.ownerGroupId ?? null,
      productCategory: product?.category ?? null,
      resources: (product?.grants ?? []).map((g) => ({
        resourceType: g.resourceType as 'entitlement' | 'application' | 'group',
        resourceId: g.resourceId,
      })),
    };

    const previews: StagePreview[] = [];
    for (const stage of stages) {
      const result = await resolveStageApprovers(tx, stage, subject, on);
      const names = await tx.person.findMany({
        where: {
          id: {
            in: [
              ...result.approvers.map((a) => a.personId),
              ...result.dropped.map((d) => d.personId),
            ],
          },
        },
        select: { id: true, givenName: true, familyName: true },
      });
      const nameOf = (personId: string) => {
        const person = names.find((n) => n.id === personId);
        return person === undefined
          ? personId
          : `${person.givenName} ${person.familyName}`;
      };

      previews.push({
        sequence: stage.sequence,
        name: stage.name,
        selector: stage.selector,
        quorum: stage.quorum,
        usedFallback: result.usedFallback,
        approvers: result.approvers.map((a) => ({
          personId: a.personId,
          displayName: nameOf(a.personId),
          via: a.via,
        })),
        dropped: result.dropped.map((d) => ({
          personId: d.personId,
          displayName: nameOf(d.personId),
          reason: d.reason,
        })),
        blocked: result.approvers.length === 0,
      });
    }
    return previews;
  });
}
