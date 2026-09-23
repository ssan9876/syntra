import { withTenant, type TenantClient } from '@syntra/db';
import { z } from 'zod';
import type { LifecycleKind } from './operation-service.js';

/**
 * The controls a lifecycle pilot runs under, one row per tenant.
 *
 * Every field has a default in the schema, and `getLifecyclePolicy` returns
 * those defaults when no row has ever been written, so nothing that consumes
 * a policy has to distinguish "never configured" from "configured to the
 * default". The defaults are the conservative ones: privileged group changes
 * and large requeues need a second person; an urgent departure is expected
 * to have disabled sign-in within fifteen minutes.
 */
export interface LifecyclePolicy {
  requireApprovalForAccountCreation: boolean;
  requireApprovalForPrivilegedGroups: boolean;
  privilegedGroupPatterns: string[];
  requireApprovalForUrgentDeparture: boolean;
  requireApprovalForBulkRequeue: boolean;
  bulkRequeueThreshold: number;
  maxConcurrentTargetOperations: number;
  urgentLeaverSloMinutes: number;
  onboardSloHours: number;
  moveSloHours: number;
  offboardSloHours: number;
  escalationOwnerUserId: string | null;
  notifyOnFailure: boolean;
  notifyOnOverdue: boolean;
  notifyOnAccessBlocked: boolean;
  receiptRetentionDays: number;
  observationRetentionDays: number;
  notificationRetentionDays: number;
  simulationRetentionDays: number;
  lifecycleOperationRetentionDays: number;
  auditRetentionDays: number | null;
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  requireApprovalForAccountCreation: false,
  requireApprovalForPrivilegedGroups: true,
  privilegedGroupPatterns: ['admin', 'privileged', 'domain admins', 'global admin'],
  requireApprovalForUrgentDeparture: false,
  requireApprovalForBulkRequeue: true,
  bulkRequeueThreshold: 10,
  maxConcurrentTargetOperations: 8,
  urgentLeaverSloMinutes: 15,
  onboardSloHours: 24,
  moveSloHours: 24,
  offboardSloHours: 24,
  escalationOwnerUserId: null,
  notifyOnFailure: true,
  notifyOnOverdue: true,
  notifyOnAccessBlocked: true,
  receiptRetentionDays: 365,
  observationRetentionDays: 90,
  notificationRetentionDays: 180,
  simulationRetentionDays: 30,
  // Long enough that a delayed HR delivery cannot accidentally become a new
  // operation, while still allowing a contractual retention policy to expire
  // old idempotency keys deliberately.
  lifecycleOperationRetentionDays: 730,
  auditRetentionDays: null,
};

const days = z.number().int().min(1).max(3650);

/** What an administrator may change. Every field optional; unspecified means unchanged. */
export const lifecyclePolicyUpdateSchema = z
  .object({
    requireApprovalForAccountCreation: z.boolean(),
    requireApprovalForPrivilegedGroups: z.boolean(),
    privilegedGroupPatterns: z.array(z.string().trim().min(1).max(100)).max(50),
    requireApprovalForUrgentDeparture: z.boolean(),
    requireApprovalForBulkRequeue: z.boolean(),
    bulkRequeueThreshold: z.number().int().min(1).max(10_000),
    maxConcurrentTargetOperations: z.number().int().min(1).max(256),
    urgentLeaverSloMinutes: z.number().int().min(1).max(24 * 60),
    onboardSloHours: z.number().int().min(1).max(24 * 90),
    moveSloHours: z.number().int().min(1).max(24 * 90),
    offboardSloHours: z.number().int().min(1).max(24 * 90),
    escalationOwnerUserId: z.string().uuid().nullable(),
    notifyOnFailure: z.boolean(),
    notifyOnOverdue: z.boolean(),
    notifyOnAccessBlocked: z.boolean(),
    receiptRetentionDays: days,
    observationRetentionDays: days,
    notificationRetentionDays: days,
    simulationRetentionDays: days,
    lifecycleOperationRetentionDays: days,
    // Null means never. A floor of 90 days: an audit trail shorter than a
    // quarter cannot answer the questions an audit asks of it.
    auditRetentionDays: z.number().int().min(90).max(3650).nullable(),
  })
  .partial()
  .strict();
export type LifecyclePolicyUpdate = z.infer<typeof lifecyclePolicyUpdateSchema>;

function fromRow(row: Record<string, unknown> | null): LifecyclePolicy {
  if (!row) return { ...DEFAULT_LIFECYCLE_POLICY };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_LIFECYCLE_POLICY) as (keyof LifecyclePolicy)[]) {
    out[key] = row[key] === undefined ? DEFAULT_LIFECYCLE_POLICY[key] : row[key];
  }
  return out as unknown as LifecyclePolicy;
}

export async function readLifecyclePolicy(tx: TenantClient): Promise<LifecyclePolicy> {
  const row = await tx.lifecyclePolicy.findFirst();
  return fromRow(row as Record<string, unknown> | null);
}

export async function getLifecyclePolicy(tenantId: string): Promise<LifecyclePolicy> {
  return withTenant(tenantId, readLifecyclePolicy);
}

export async function updateLifecyclePolicy(
  tenantId: string,
  update: LifecyclePolicyUpdate,
  actorUserId: string | null,
): Promise<LifecyclePolicy> {
  // `exactOptionalPropertyTypes`: a field left out of the request must be
  // absent from the write, not present as `undefined`.
  const parsed = Object.fromEntries(
    Object.entries(lifecyclePolicyUpdateSchema.parse(update)).filter(([, value]) => value !== undefined),
  ) as { [K in keyof LifecyclePolicyUpdate]-?: Exclude<LifecyclePolicyUpdate[K], undefined> };
  return withTenant(tenantId, async (tx) => {
    if (parsed.escalationOwnerUserId) {
      // A person who does not exist cannot own an escalation; refusing here
      // is what keeps `queueLifecycleAlerts` from writing mail to nobody.
      await tx.user.findFirstOrThrow({ where: { id: parsed.escalationOwnerUserId } });
    }
    const row = await tx.lifecyclePolicy.upsert({
      where: { tenantId },
      create: { tenantId, ...parsed, updatedByUserId: actorUserId },
      update: { ...parsed, updatedByUserId: actorUserId },
    });
    return fromRow(row as unknown as Record<string, unknown>);
  });
}

/**
 * The service level for one operation, in minutes, or null where the policy
 * sets none. Urgency is carried by priority: a `critical` departure is the
 * fifteen-minute case the roadmap names; everything else uses the per-kind
 * hours.
 */
export function sloMinutesFor(
  policy: LifecyclePolicy,
  kind: LifecycleKind,
  priority: string,
): number | null {
  switch (kind) {
    case 'offboard':
      return priority === 'critical' || priority === 'high'
        ? policy.urgentLeaverSloMinutes
        : policy.offboardSloHours * 60;
    case 'onboard':
      return policy.onboardSloHours * 60;
    case 'move':
      return policy.moveSloHours * 60;
    default:
      return null;
  }
}

/** Case-insensitive substring match of the policy's patterns against a group name. */
export function matchesPrivilegedPattern(policy: LifecyclePolicy, displayName: string): boolean {
  const name = displayName.toLocaleLowerCase();
  return policy.privilegedGroupPatterns.some((pattern) => {
    const needle = pattern.trim().toLocaleLowerCase();
    return needle.length > 0 && name.includes(needle);
  });
}

export interface ApprovalContext {
  kind: LifecycleKind;
  priority: string;
  /** The operation would create at least one target account. */
  createsAccount: boolean;
  /** Names of entitlements the operation would grant or revoke. */
  entitlementChanges: { displayName: string; privileged: boolean }[];
  /** For a bulk requeue: how many operations are being requeued at once. */
  bulkCount?: number;
}

/**
 * Whether policy requires a second person before this operation may touch a
 * target, and the sentence the approver is shown. The first control that
 * fires names the reason; the others are folded into the same sentence so
 * an approver signs for everything the operation will do.
 */
export function approvalDecision(
  policy: LifecyclePolicy,
  context: ApprovalContext,
): { required: boolean; reason: string | null } {
  const reasons: string[] = [];
  if (policy.requireApprovalForAccountCreation && context.createsAccount) {
    reasons.push('creates a target account');
  }
  if (policy.requireApprovalForPrivilegedGroups) {
    const privileged = context.entitlementChanges.filter(
      (change) => change.privileged || matchesPrivilegedPattern(policy, change.displayName),
    );
    if (privileged.length > 0) {
      reasons.push(
        `changes privileged access (${privileged
          .map((change) => change.displayName)
          .slice(0, 5)
          .join(', ')}${privileged.length > 5 ? ', …' : ''})`,
      );
    }
  }
  if (
    policy.requireApprovalForUrgentDeparture &&
    context.kind === 'offboard' &&
    (context.priority === 'critical' || context.priority === 'high')
  ) {
    reasons.push('is an urgent departure');
  }
  if (
    policy.requireApprovalForBulkRequeue &&
    context.bulkCount !== undefined &&
    context.bulkCount >= policy.bulkRequeueThreshold
  ) {
    reasons.push(`requeues ${context.bulkCount} operations at once`);
  }
  return reasons.length === 0
    ? { required: false, reason: null }
    : { required: true, reason: `This operation ${reasons.join(' and ')}.` };
}
