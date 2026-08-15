import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';

interface ChangeRow {
  id: string;
  changeType: string;
  targetType: string;
  targetId: string | null;
  sourceAnchor: string | null;
  before: unknown;
  after: unknown;
  status: string;
}

/**
 * What a single case in `performChange` decided actually happened. The
 * outcome is data a branch hands back, not something inferred from which
 * line execution happens to reach: a branch that returns nothing is a
 * compile error (see `performChange`'s return type), not a silent success.
 */
interface ApplyResult {
  outcome: 'success' | 'failure';
  extra?: Record<string, unknown>;
}

const fields = (value: unknown) => (value ?? {}) as Record<string, string>;

/**
 * Writes the one audit event for a change, from the outcome `performChange`
 * decided. There is exactly one call site, so there is exactly one place
 * that can get the outcome wrong.
 */
async function audit(
  tx: TenantClient,
  change: ChangeRow,
  runId: string,
  result: ApplyResult,
): Promise<void> {
  await recordEvent(tx, {
    actorUserId: null,
    action: `sync.${change.changeType}`,
    targetType: change.targetType,
    targetId: change.targetId,
    outcome: result.outcome,
    sourceIp: null,
    payload: { runId, anchor: change.sourceAnchor, ...result.extra },
  });
}

/**
 * Performs the mutation for one change and reports what happened.
 *
 * Every case must return an `ApplyResult`; there is no shared "fell out of
 * the switch, so it must have succeeded" path for `applyChange` to trust.
 * TypeScript enforces this: with an explicit `Promise<ApplyResult>` return
 * type, a case that reaches the end of its block without returning is a
 * compile error, not a change that quietly gets audited as a success it
 * never earned.
 */
async function performChange(
  tx: TenantClient,
  change: ChangeRow,
  sourceId: string,
  runId: string,
  tenantId: string,
): Promise<ApplyResult> {
  const after = fields(change.after);

  switch (change.changeType) {
    case 'create_user': {
      const created = await tx.user.create({
        data: {
          tenantId,
          login: after.login ?? '',
          email: after.email ?? '',
          displayName: after.displayName ?? after.login ?? '',
          sourceId,
          sourceAnchor: change.sourceAnchor,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied', targetId: created.id },
      });
      return { outcome: 'success' };
    }

    case 'update_user': {
      await tx.user.update({
        where: { id: change.targetId! },
        data: after,
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      return { outcome: 'success' };
    }

    case 'deactivate_user': {
      await tx.user.update({
        where: { id: change.targetId! },
        data: {
          status: 'inactive',
          statusReason: `Absent from directory source, run ${runId}`,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      return { outcome: 'success' };
    }

    case 'reactivate_user': {
      await tx.user.update({
        where: { id: change.targetId! },
        data: { status: 'active', statusReason: null },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      return { outcome: 'success' };
    }

    case 'create_group': {
      const created = await tx.group.create({
        data: {
          tenantId,
          name: after.name ?? '',
          description: after.description ?? null,
          sourceId,
          sourceAnchor: change.sourceAnchor,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied', targetId: created.id },
      });
      return { outcome: 'success' };
    }

    case 'update_group': {
      await tx.group.update({ where: { id: change.targetId! }, data: after });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      return { outcome: 'success' };
    }

    case 'deactivate_group': {
      // Deactivated, never deleted, and memberships are left in place:
      // deleting a group silently revokes access from everyone in it.
      await tx.group.update({
        where: { id: change.targetId! },
        data: {
          status: 'inactive',
          statusReason: `Absent from directory source, run ${runId}`,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      return { outcome: 'success' };
    }

    case 'create_org_unit': {
      const created = await tx.orgUnit.create({
        data: {
          tenantId,
          name: after.name ?? '',
          sourceId,
          sourceAnchor: change.sourceAnchor,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied', targetId: created.id },
      });
      return { outcome: 'success' };
    }

    case 'update_org_unit': {
      await tx.orgUnit.update({ where: { id: change.targetId! }, data: after });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      return { outcome: 'success' };
    }

    case 'add_member': {
      const group = await tx.group.findFirst({
        where: { sourceId, sourceAnchor: after.groupAnchor ?? null },
      });
      const user = await tx.user.findFirst({
        where: { sourceId, sourceAnchor: after.memberAnchor ?? null },
      });
      if (!group || !user) {
        const missing = !group && !user ? 'group and member' : !group ? 'group' : 'member';
        await tx.syncChange.update({
          where: { id: change.id },
          data: {
            status: 'failed',
            message: 'group or member not found after applying earlier changes',
          },
        });
        return { outcome: 'failure', extra: { missing } };
      }
      await tx.groupMembership.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        create: { tenantId, groupId: group.id, userId: user.id },
        update: {},
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      return { outcome: 'success' };
    }

    case 'remove_member': {
      const before = fields(change.before);
      const group = await tx.group.findFirst({
        where: { sourceId, sourceAnchor: before.groupAnchor ?? null },
      });
      const user = await tx.user.findFirst({
        where: { sourceId, sourceAnchor: before.memberAnchor ?? null },
      });
      if (!group || !user) {
        const missing = !group && !user ? 'group and member' : !group ? 'group' : 'member';
        await tx.syncChange.update({
          where: { id: change.id },
          data: {
            status: 'failed',
            message: 'group or member not found; cannot confirm the membership was removed',
          },
        });
        return { outcome: 'failure', extra: { missing } };
      }
      // Both resolved: removing a membership that is already gone is
      // genuinely idempotent, so this is a success regardless of whether
      // deleteMany actually deleted a row.
      await tx.groupMembership.deleteMany({
        where: { groupId: group.id, userId: user.id },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      return { outcome: 'success' };
    }

    default:
      await tx.syncChange.update({
        where: { id: change.id },
        data: {
          status: 'failed',
          message: `unknown change type: ${change.changeType}`,
        },
      });
      return { outcome: 'failure', extra: { changeType: change.changeType } };
  }
}

/**
 * Applies one proposed change and records it. The caller runs this inside a
 * transaction, so the change and its audit entry commit together or not at
 * all: a directory change without a record of it is worse than no change.
 */
export async function applyChange(
  tx: TenantClient,
  change: ChangeRow,
  sourceId: string,
  runId: string,
): Promise<void> {
  const tenantId = await currentTenant(tx);
  const result = await performChange(tx, change, sourceId, runId, tenantId);
  await audit(tx, change, runId, result);
}
