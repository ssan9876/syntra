import type { TenantClient } from '@syntra/db';
import type { ObjectType } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { revokeAllForUser } from '../auth/session-service.js';
import { revokeAllRefreshTokensForUser } from '../auth/refresh-token.js';
import { unassignableFields } from './mapping.js';

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
 * Keys the DIFF puts in `after` that no mapping may target and no `update`
 * may receive.
 *
 * `parentAnchor` is where the directory says the object sits. It travels in
 * `after` so the run's review shows a move as one before-and-after line like
 * any other change, but it names a source anchor rather than a column, so it
 * has to be translated to a local id and taken out before Prisma sees the
 * blob. `ASSIGNABLE_FIELDS` deliberately does not list it: a mapping rule
 * pointing at it would let a source attribute rewrite the hierarchy.
 */
const STRUCTURAL = ['parentAnchor'] as const;

const writable = (after: Record<string, string>): Record<string, string> => {
  const copy = { ...after };
  for (const key of STRUCTURAL) delete copy[key];
  return copy;
};

/**
 * Turns the anchor of an organizational unit into its local row id.
 *
 * An empty anchor is the directory saying "at the top of what you asked me
 * for", which is a null placement. An anchor naming a unit this tenant has no
 * row for returns undefined, and every caller treats that as "change nothing":
 * the unit is almost always one whose own `create_org_unit` failed in the same
 * run, and detaching a person because we could not create their department is
 * the mistake this subsystem exists not to make.
 */
async function resolveUnit(
  tx: TenantClient,
  sourceId: string,
  anchor: string | undefined,
): Promise<string | null | undefined> {
  if (anchor === undefined) return undefined;
  if (anchor === '') return null;
  const unit = await tx.orgUnit.findFirst({
    where: { sourceId, sourceAnchor: anchor },
    select: { id: true },
  });
  return unit?.id;
}

/**
 * The object type an `update_*` change writes to. Only these three pass a
 * mapped blob straight into an `update`, so only these three need checking.
 */
const MAPPED_WRITES: Record<string, ObjectType> = {
  update_user: 'user',
  update_group: 'group',
  update_org_unit: 'orgUnit',
  // CREATES TOO. They cherry-pick named columns, so an unassignable field was
  // never a write risk here the way it is on `update_*` — it was a SILENCE
  // risk. The administrator reviewed a diff that named the field, applied it,
  // and got a row without it, with nothing anywhere saying so. A run that
  // diverges from the diff somebody approved has to say it diverged.
  create_user: 'user',
  create_group: 'group',
  create_org_unit: 'orgUnit',
};

/**
 * Refuses a create or an update carrying a field a mapping was never allowed
 * to write.
 *
 * `setMappings` rejects these at configuration time, which is where an
 * administrator can see the message. This is the second gate, for a mapping
 * stored before that check existed: `update_*` passes the mapped blob
 * straight to `update({ data })`, so a single row naming `status` would let
 * directory content deactivate an account through a change type the guard
 * does not count. Refusing the change is deliberate — silently dropping the
 * offending field would apply something other than what was reviewed.
 */
async function rejectUnassignable(
  tx: TenantClient,
  change: ChangeRow,
  after: Record<string, string>,
): Promise<ApplyResult | undefined> {
  const objectType = MAPPED_WRITES[change.changeType];
  if (!objectType) return undefined;

  const rejected = unassignableFields(objectType, Object.keys(writable(after)));
  if (rejected.length === 0) return undefined;

  await tx.syncChange.update({
    where: { id: change.id },
    data: {
      status: 'failed',
      message:
        `refusing to write ${rejected.join(', ')}: a mapping may not set ` +
        `these fields on a ${objectType}`,
    },
  });
  return { outcome: 'failure', extra: { rejectedFields: rejected } };
}

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

  const rejected = await rejectUnassignable(tx, change, after);
  if (rejected) return rejected;

  switch (change.changeType) {
    case 'create_user': {
      const unit = await resolveUnit(tx, sourceId, after.parentAnchor);
      const created = await tx.user.create({
        data: {
          tenantId,
          login: after.login ?? '',
          email: after.email ?? '',
          displayName: after.displayName ?? after.login ?? '',
          // Spread rather than assigned: `undefined` means the unit could not
          // be resolved, and Prisma would take an explicit `orgUnitId:
          // undefined` as "leave it null" — the same value it takes for a
          // person the directory genuinely places nowhere. Those are different
          // facts and this is the only place they can still be told apart.
          ...(unit === undefined ? {} : { orgUnitId: unit }),
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
      const unit = await resolveUnit(tx, sourceId, after.parentAnchor);
      await tx.user.update({
        where: { id: change.targetId! },
        data: {
          ...writable(after),
          ...(unit === undefined ? {} : { orgUnitId: unit }),
        },
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
      // A leaver dropping out of the HR feed is the commonest offboarding
      // there is, and it must take effect at their next request rather than
      // at their next session expiry. Same transaction as the status change,
      // for the same reason `deactivateUser` does it: a deactivation with the
      // sessions left behind reads as done and is not.
      await revokeAllForUser(tx, change.targetId!);
      await revokeAllRefreshTokensForUser(tx, change.targetId!);
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

    case 'reactivate_group': {
      // No session revocation to mirror `reactivate_user`'s: a group holds no
      // sessions. The memberships were never removed on deactivation, so the
      // group comes back granting exactly what it granted before — which is
      // the whole reason deactivation is not a delete.
      await tx.group.update({
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
      await tx.group.update({ where: { id: change.targetId! }, data: writable(after) });
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
      const parent = await resolveUnit(tx, sourceId, after.parentAnchor);
      const created = await tx.orgUnit.create({
        data: {
          tenantId,
          name: after.name ?? '',
          ...(parent === undefined ? {} : { parentId: parent }),
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
      const parent = await resolveUnit(tx, sourceId, after.parentAnchor);
      // A unit that is its own parent is a tree with a cycle in it, and every
      // later walk of that tree — scoped role resolution included — never
      // terminates. The directory cannot produce one; a DN comparison that
      // wrongly matched a unit to itself could.
      const reparent =
        parent === undefined || parent === change.targetId ? {} : { parentId: parent };
      await tx.orgUnit.update({
        where: { id: change.targetId! },
        data: { ...writable(after), ...reparent },
      });
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
  // CLAIMED FIRST, in the same transaction as the write.
  //
  // `applyRun` reads the proposed changes and then applies them one
  // transaction at a time, so two applies of one run — two administrators on
  // the same screen, or an administrator and the scheduler's `autoApply` —
  // both read the same rows as `proposed` and both go on to write. The
  // schema bounds the damage rather than preventing it: the unique constraint
  // on `(tenantId, sourceId, sourceAnchor)` turns a duplicated create into a
  // failed change, and an update applied twice is merely applied twice. What
  // is not bounded is the audit trail, which grows a second event saying the
  // same thing happened again.
  //
  // The `where` is the lock. Postgres blocks the second `updateMany` on the
  // row until the first transaction commits, then re-evaluates it under READ
  // COMMITTED and finds `applied` — so the count comes back zero and this
  // returns having done nothing. No new status, nothing to strand: a crash
  // rolls the claim back with the work it was claiming.
  const claimed = await tx.syncChange.updateMany({
    where: { id: change.id, status: 'proposed' },
    data: { status: 'proposed' },
  });
  if (claimed.count === 0) return;

  const tenantId = await currentTenant(tx);
  const result = await performChange(tx, change, sourceId, runId, tenantId);
  await audit(tx, change, runId, result);
}
