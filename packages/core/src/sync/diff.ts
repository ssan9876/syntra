import type { ObjectType } from '@syntra/connectors';
import type { Correlation, ExistingObject } from './correlate.js';

export type ChangeType =
  | 'create_user'
  | 'update_user'
  | 'deactivate_user'
  | 'reactivate_user'
  | 'reactivate_group'
  | 'create_group'
  | 'update_group'
  | 'deactivate_group'
  | 'add_member'
  | 'remove_member'
  | 'create_org_unit'
  | 'update_org_unit';

export type TargetType = 'User' | 'Group' | 'OrgUnit' | 'GroupMembership';

export interface ProposedChange {
  changeType: ChangeType;
  targetType: TargetType;
  targetId: string | null;
  sourceAnchor: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  status: 'proposed' | 'conflict';
  message?: string;
}

export interface MembershipState {
  groupAnchor: string;
  memberAnchors: string[];
}

const TARGET: Record<ObjectType, TargetType> = {
  user: 'User',
  group: 'Group',
  orgUnit: 'OrgUnit',
};

const VERB: Record<ObjectType, Record<'create' | 'update', ChangeType>> = {
  user: { create: 'create_user', update: 'update_user' },
  group: { create: 'create_group', update: 'update_group' },
  orgUnit: { create: 'create_org_unit', update: 'update_org_unit' },
};

/**
 * Compares mapped objects against what is stored and emits one change per
 * difference. An unchanged object produces nothing, so a run over an unchanged
 * directory is empty rather than a wall of no-ops.
 */
export function diffObjects(
  correlations: Correlation[],
  absent: ExistingObject[],
  currentFields: Map<string, Record<string, string>>,
): ProposedChange[] {
  const changes: ProposedChange[] = [];

  for (const correlation of correlations) {
    const { object } = correlation;
    const targetType = TARGET[object.objectType];

    if (correlation.kind === 'conflict') {
      changes.push({
        changeType: VERB[object.objectType].create,
        targetType,
        targetId: correlation.existing.id,
        sourceAnchor: object.anchor,
        before: null,
        after: object.fields,
        status: 'conflict',
        message: correlation.reason,
      });
      continue;
    }

    if (correlation.kind === 'new') {
      changes.push({
        changeType: VERB[object.objectType].create,
        targetType,
        targetId: null,
        sourceAnchor: object.anchor,
        before: null,
        after: object.fields,
        status: 'proposed',
      });
      continue;
    }

    const existing = correlation.existing;

    // A matched object that is inactive has reappeared in the source. Propose
    // restoring it; nothing is applied without an explicit apply step.
    // Org units have no status column, so only users and groups can be reactivated.
    //
    // `reactivate_group`, NOT `update_group`. Status is not a field a mapping
    // may write — `rejectUnassignable` refuses it, and rightly, or a source
    // attribute could deactivate people — so routing a group's return through
    // the generic update meant the change failed on every run, forever, and
    // the group stayed dead with its memberships intact and granting nothing.
    // Deactivation is chosen over deletion precisely because it is
    // recoverable; a group that cannot come back is deleted in all but name.
    if (existing.status !== 'active' && object.objectType !== 'orgUnit') {
      changes.push({
        changeType:
          object.objectType === 'user' ? 'reactivate_user' : 'reactivate_group',
        targetType,
        targetId: existing.id,
        sourceAnchor: object.anchor,
        before: { status: existing.status },
        after: { status: 'active' },
        status: 'proposed',
      });
      continue;
    }

    const current = currentFields.get(existing.id) ?? {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(object.fields)) {
      if (current[field] !== value) {
        before[field] = current[field] ?? null;
        after[field] = value;
      }
    }

    if (Object.keys(after).length > 0) {
      changes.push({
        changeType: VERB[object.objectType].update,
        targetType,
        targetId: existing.id,
        sourceAnchor: object.anchor,
        before,
        after,
        status: 'proposed',
      });
    }
  }

  for (const row of absent) {
    // Org units carry scoped administrative role assignments. Removing one would
    // silently narrow or widen someone's authority, which is consequential enough
    // to be a human decision, not a sync outcome.
    if (row.objectType === 'orgUnit') {
      continue;
    }

    changes.push({
      changeType:
        row.objectType === 'group' ? 'deactivate_group' : 'deactivate_user',
      targetType: TARGET[row.objectType],
      targetId: row.id,
      sourceAnchor: row.sourceAnchor,
      before: { status: row.status },
      after: { status: 'inactive' },
      status: 'proposed',
    });
  }

  return changes;
}

/**
 * Membership is compared as a set, since neither the source nor the database
 * promises an order.
 *
 * A group missing from `desired` is skipped entirely: its absence from the
 * read is already handled as a deactivation, and emptying its membership as
 * well would revoke access twice over.
 *
 * `incompleteGroups` names the groups whose membership this run could not read
 * in full — a member DN that resolved to nothing the source returned. Those
 * groups get their ADDITIONS and none of their removals. `desired` is
 * differenced against what Syntra holds, so a member we failed to resolve is
 * indistinguishable from a member who left, and the two have opposite correct
 * answers. Every other partial read in this subsystem is handled the same way:
 * counted, reported, and never allowed to look like an absence.
 */
export function diffMemberships(
  desired: MembershipState[],
  current: MembershipState[],
  incompleteGroups: ReadonlySet<string>,
): ProposedChange[] {
  const changes: ProposedChange[] = [];
  const currentByGroup = new Map(
    current.map((m) => [m.groupAnchor, new Set(m.memberAnchors)]),
  );

  for (const group of desired) {
    const now = currentByGroup.get(group.groupAnchor) ?? new Set<string>();
    const wanted = new Set(group.memberAnchors);

    for (const anchor of wanted) {
      if (!now.has(anchor)) {
        changes.push({
          changeType: 'add_member',
          targetType: 'GroupMembership',
          targetId: null,
          sourceAnchor: group.groupAnchor,
          before: null,
          after: { groupAnchor: group.groupAnchor, memberAnchor: anchor },
          status: 'proposed',
        });
      }
    }

    // Additions above, removals below, and the incomplete read stops here.
    // An add is safe on a partial read — the source named that member — while
    // a removal on a partial read is a revocation caused by our own failure.
    if (incompleteGroups.has(group.groupAnchor)) continue;

    for (const anchor of now) {
      if (!wanted.has(anchor)) {
        changes.push({
          changeType: 'remove_member',
          targetType: 'GroupMembership',
          targetId: null,
          sourceAnchor: group.groupAnchor,
          before: { groupAnchor: group.groupAnchor, memberAnchor: anchor },
          after: null,
          status: 'proposed',
        });
      }
    }
  }

  return changes;
}
