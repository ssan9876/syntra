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

const fields = (value: unknown) => (value ?? {}) as Record<string, string>;

/**
 * Writes the one audit event for a change. Centralised so that "what
 * actually happened" (success or failure) is always the value the calling
 * branch decided, never a value the bottom of the function assumes on its
 * behalf.
 */
async function audit(
  tx: TenantClient,
  change: ChangeRow,
  runId: string,
  outcome: 'success' | 'failure',
  extra?: Record<string, unknown>,
): Promise<void> {
  await recordEvent(tx, {
    actorUserId: null,
    action: `sync.${change.changeType}`,
    targetType: change.targetType,
    targetId: change.targetId,
    outcome,
    sourceIp: null,
    payload: { runId, anchor: change.sourceAnchor, ...extra },
  });
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
      break;
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
      break;
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
      break;
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
      break;
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
      break;
    }

    case 'update_group': {
      await tx.group.update({ where: { id: change.targetId! }, data: after });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
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
      break;
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
      break;
    }

    case 'update_org_unit': {
      await tx.orgUnit.update({ where: { id: change.targetId! }, data: after });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
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
        // Explicit return, not break: the change is failed, so the event
        // must say `failure`, not fall through to the success event below.
        await audit(tx, change, runId, 'failure', { missing });
        return;
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
      break;
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
        await audit(tx, change, runId, 'failure', { missing });
        return;
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
      break;
    }

    default:
      await tx.syncChange.update({
        where: { id: change.id },
        data: {
          status: 'failed',
          message: `unknown change type: ${change.changeType}`,
        },
      });
      return;
  }

  await audit(tx, change, runId, 'success');
}
