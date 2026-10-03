import { oplog } from '@syntra/connectors';
import { Prisma, withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import {
  conditionFacts,
  evaluateCondition,
  type Condition,
  type ConditionContract,
} from '../provision/condition.js';
import { boundedConditionSchema } from '../provision/target-service.js';
import { currentTenant } from '../tenant-context.js';

/**
 * DYNAMIC GROUPS.
 *
 * A group with a `membershipRule` holds, as 'rule' memberships, every login
 * whose person matches the rule. The rule uses the BusinessRule grammar, so a
 * group and a target rule written the same way reach the same people.
 *
 * A person matches when any contract in force today satisfies the rule. A
 * person with no contract in force is tested once against an empty contract,
 * so a rule on `person.status` alone still reaches leavers.
 *
 * Only 'rule' rows are added or removed here. A 'direct' member stays a member
 * whatever the rule says, and a person under a processing restriction is not
 * added (a restriction never widens access) but is still removed.
 */

export const GROUP_RULES_JOB = 'directory.group-rules';

const EMPTY_CONTRACT: ConditionContract = {
  department: null,
  jobTitle: null,
  costCentre: null,
  employer: null,
  location: null,
  fte: null,
};

/** How many user ids an audit event lists before it only counts. */
const AUDIT_ID_LIMIT = 100;

/**
 * A pass that would remove more than this share of a group's rule members
 * removes nobody and adds nobody, unless confirmed: an HR feed that lost a
 * department must not empty the group that grants its access.
 */
export const GROUP_RULE_MAX_REMOVE_SHARE = 0.25;
/** At or below this many removals the share rule does not apply. */
export const GROUP_RULE_REMOVE_FLOOR = 5;

export class GroupRuleSourceOwnedError extends Error {
  constructor(public readonly groupId: string) {
    super(`group ${groupId} is synced from a directory source`);
  }
}

export interface GroupRuleChanges {
  add: string[];
  remove: string[];
  /** Rule members who stay. */
  keep: string[];
}

export interface GroupRuleResult extends GroupRuleChanges {
  /** True when the pass was held and nothing was written. */
  held: boolean;
}

/** Whether these changes remove too much of the group to apply unconfirmed. */
export function exceedsRemovalLimit(changes: GroupRuleChanges): boolean {
  const ruleMembers = changes.remove.length + changes.keep.length;
  return (
    changes.remove.length > GROUP_RULE_REMOVE_FLOOR &&
    changes.remove.length > ruleMembers * GROUP_RULE_MAX_REMOVE_SHARE
  );
}

/** Parses a stored or submitted rule. Throws a ZodError when it is not one. */
export function parseMembershipRule(raw: unknown): Condition {
  return boundedConditionSchema.parse(raw);
}

/** The ids of every login whose person matches `condition` on `on`. */
export async function usersMatchingRule(
  tx: TenantClient,
  condition: Condition,
  on: Date,
): Promise<{ matching: Set<string>; restricted: Set<string> }> {
  const users = await tx.user.findMany({
    where: { personId: { not: null } },
    select: { id: true, personId: true },
  });
  const personIds = [...new Set(users.map((u) => u.personId!))];
  const persons = await tx.person.findMany({
    where: { id: { in: personIds } },
    select: {
      id: true,
      status: true,
      processingRestrictedAt: true,
      contracts: {
        where: { startDate: { lte: on }, OR: [{ endDate: null }, { endDate: { gte: on } }] },
        select: {
          department: true,
          jobTitle: true,
          costCentre: true,
          employer: true,
          location: true,
          fte: true,
        },
      },
    },
  });

  const matchingPersons = new Set<string>();
  const restrictedPersons = new Set<string>();
  for (const person of persons) {
    const contracts: ConditionContract[] =
      person.contracts.length === 0
        ? [EMPTY_CONTRACT]
        : person.contracts.map((c) => ({ ...c, fte: c.fte === null ? null : Number(c.fte) }));
    if (contracts.some((c) => evaluateCondition(condition, conditionFacts(person, c)))) {
      matchingPersons.add(person.id);
    }
    if (person.processingRestrictedAt) restrictedPersons.add(person.id);
  }

  const matching = new Set<string>();
  const restricted = new Set<string>();
  for (const user of users) {
    if (matchingPersons.has(user.personId!)) matching.add(user.id);
    if (restrictedPersons.has(user.personId!)) restricted.add(user.id);
  }
  return { matching, restricted };
}

/**
 * What applying `condition` to the group would change, without changing it.
 * A null condition removes every rule member.
 */
export async function previewGroupRule(
  tx: TenantClient,
  groupId: string,
  condition: Condition | null,
  on: Date = new Date(),
): Promise<GroupRuleChanges> {
  const memberships = await tx.groupMembership.findMany({
    where: { groupId },
    select: { userId: true, origin: true },
  });
  const ruleMembers = new Set(memberships.filter((m) => m.origin === 'rule').map((m) => m.userId));
  const allMembers = new Set(memberships.map((m) => m.userId));

  if (condition === null) return { add: [], remove: [...ruleMembers], keep: [] };

  const { matching, restricted } = await usersMatchingRule(tx, condition, on);
  const add = [...matching].filter((id) => !allMembers.has(id) && !restricted.has(id));
  const remove = [...ruleMembers].filter((id) => !matching.has(id));
  const keep = [...ruleMembers].filter((id) => matching.has(id));
  return { add, remove, keep };
}

/**
 * Brings one group's rule memberships in line with its rule, and audits the
 * change when there is one. An inactive group is left as it is: deactivation
 * freezes membership, and reactivation picks up on the next pass.
 *
 * A pass over {@link exceedsRemovalLimit} is held unless `confirm` is set:
 * nothing is written, and `group.ruleHeld` is audited.
 */
export async function applyGroupRule(
  tx: TenantClient,
  groupId: string,
  opts: { on?: Date; actorUserId?: string | null; sourceIp?: string | null; confirm?: boolean } = {},
): Promise<GroupRuleResult | null> {
  const group = await tx.group.findUnique({ where: { id: groupId } });
  if (!group || group.status !== 'active' || group.sourceId) return null;

  const on = opts.on ?? new Date();
  const condition = group.membershipRule === null ? null : parseMembershipRule(group.membershipRule);
  const changes = await previewGroupRule(tx, groupId, condition, on);

  if (opts.confirm !== true && exceedsRemovalLimit(changes)) {
    const ruleMembers = changes.remove.length + changes.keep.length;
    oplog('warn', `group rule held: would remove ${changes.remove.length} of ${ruleMembers} rule members`, {
      tenantId: await currentTenant(tx),
      groupId,
    });
    await recordEvent(tx, {
      actorUserId: opts.actorUserId ?? null,
      action: 'group.ruleHeld',
      targetType: 'Group',
      targetId: groupId,
      outcome: 'failure',
      sourceIp: opts.sourceIp ?? null,
      payload: {
        group: group.name,
        wouldRemove: changes.remove.length,
        ruleMembers,
        maxShare: GROUP_RULE_MAX_REMOVE_SHARE,
        removedUserIds: changes.remove.slice(0, AUDIT_ID_LIMIT),
      },
    });
    await tx.group.update({
      where: { id: groupId },
      data: { ruleHeldAt: on, ruleHeldRemoveCount: changes.remove.length },
    });
    return { ...changes, held: true };
  }

  const tenantId = await currentTenant(tx);
  if (changes.add.length > 0) {
    await tx.groupMembership.createMany({
      data: changes.add.map((userId) => ({ tenantId, groupId, userId, origin: 'rule' })),
      skipDuplicates: true,
    });
  }
  if (changes.remove.length > 0) {
    await tx.groupMembership.deleteMany({
      where: { groupId, origin: 'rule', userId: { in: changes.remove } },
    });
  }
  await tx.group.update({
    where: { id: groupId },
    data: { ruleEvaluatedAt: on, ruleHeldAt: null, ruleHeldRemoveCount: null },
  });

  if (changes.add.length > 0 || changes.remove.length > 0) {
    await recordEvent(tx, {
      actorUserId: opts.actorUserId ?? null,
      action: 'group.ruleApply',
      targetType: 'Group',
      targetId: groupId,
      outcome: 'success',
      sourceIp: opts.sourceIp ?? null,
      payload: {
        group: group.name,
        added: changes.add.length,
        removed: changes.remove.length,
        addedUserIds: changes.add.slice(0, AUDIT_ID_LIMIT),
        removedUserIds: changes.remove.slice(0, AUDIT_ID_LIMIT),
      },
    });
  }
  return { ...changes, held: false };
}

/**
 * Sets or clears a group's rule and applies it in the same transaction, so
 * the membership never disagrees with the rule a reader sees.
 */
export async function setGroupMembershipRule(
  tx: TenantClient,
  groupId: string,
  rawRule: unknown,
  opts: { actorUserId?: string | null; sourceIp?: string | null } = {},
): Promise<GroupRuleResult | null> {
  const group = await tx.group.findUnique({ where: { id: groupId } });
  if (!group) return null;
  if (group.sourceId) throw new GroupRuleSourceOwnedError(groupId);

  const condition = rawRule === null ? null : parseMembershipRule(rawRule);
  await tx.group.update({
    where: { id: groupId },
    data: { membershipRule: (condition ?? Prisma.DbNull) as never },
  });
  await recordEvent(tx, {
    actorUserId: opts.actorUserId ?? null,
    action: 'group.ruleUpdate',
    targetType: 'Group',
    targetId: groupId,
    outcome: 'success',
    sourceIp: opts.sourceIp ?? null,
    payload: { group: group.name, from: group.membershipRule ?? null, to: condition },
  });
  // Confirmed: the administrator saved this rule after previewing it.
  return applyGroupRule(tx, groupId, { ...opts, confirm: true });
}

/**
 * Applies every active group's rule. One transaction per group, so a group
 * whose stored rule no longer parses is logged and skipped without holding up
 * the rest.
 */
export async function applyAllGroupRules(
  tenantId: string,
  on: Date = new Date(),
): Promise<{ groups: number; added: number; removed: number; failed: number; held: number }> {
  const groups = await withTenant(tenantId, (tx) =>
    tx.group.findMany({
      where: { status: 'active', sourceId: null, membershipRule: { not: Prisma.DbNull } },
      select: { id: true },
    }),
  );

  let added = 0;
  let removed = 0;
  let failed = 0;
  let held = 0;
  for (const { id } of groups) {
    try {
      const result = await withTenant(tenantId, (tx) => applyGroupRule(tx, id, { on }));
      if (result?.held) {
        held += 1;
        continue;
      }
      added += result?.add.length ?? 0;
      removed += result?.remove.length ?? 0;
    } catch (error) {
      failed += 1;
      oplog('warn', `group rule failed: ${error instanceof Error ? error.message : String(error)}`, {
        tenantId,
        groupId: id,
      });
    }
  }
  if (added > 0 || removed > 0) {
    oplog('info', `group rules applied: ${added} added, ${removed} removed`, { tenantId, added, removed });
  }
  return { groups: groups.length, added, removed, failed, held };
}

export interface GroupRulesPayload {
  tenantId: string;
}

export function registerGroupRuleJobs(scheduler: Scheduler): void {
  scheduler.register<GroupRulesPayload>(GROUP_RULES_JOB, async ({ tenantId }) => {
    await applyAllGroupRules(tenantId);
  });
}

/**
 * Hourly, so contracts starting and ending and edits made in the console are
 * picked up. An HR import applies the rules itself as soon as it finishes.
 */
export async function scheduleGroupRules(scheduler: Scheduler, tenantId: string): Promise<void> {
  await scheduler.schedule(GROUP_RULES_JOB, '23 * * * *', { tenantId }, `group-rules-${tenantId}`);
}
