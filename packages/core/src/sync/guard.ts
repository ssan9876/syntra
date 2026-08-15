import type { ChangeType, ProposedChange } from './diff.js';

export interface GuardInput {
  changes: ProposedChange[];
  recordsRead: number;
  /** Active users this source currently owns. */
  activeUsersFromSource: number;
  /** Active groups this source currently owns. */
  activeGroupsFromSource: number;
  /** Group memberships this source currently owns. */
  currentMembershipsFromSource: number;
  thresholdPercent: number;
}

export type GuardVerdict =
  | { blocked: false }
  /**
   * `requiresConfirmation` separates the guard's two refusals. A run that read
   * nothing is refused outright — there is nothing an administrator could
   * usefully confirm about a directory that may simply be unreachable. A run
   * over the threshold is refused *pending* an explicit confirmation, because
   * a real cohort departure (a contractor batch, a closed site) has to be
   * processable through sync rather than by hand.
   */
  | { blocked: true; requiresConfirmation: boolean; reason: string };

/**
 * One population the threshold is measured against. Deactivating every group
 * a source owns is as destructive as deactivating every user, and stripping
 * group memberships revokes the entitlements those groups carry — so each is
 * counted against its own denominator rather than all of them against the
 * user count. A wrong `groupFilter` that returns no groups at all used to
 * deactivate every synced group at a few percent of the user count, and sail
 * straight under the threshold.
 */
interface Population {
  changeType: ChangeType;
  verb: string;
  noun: string;
  total(input: GuardInput): number;
}

const POPULATIONS: Population[] = [
  {
    changeType: 'deactivate_user',
    verb: 'deactivate',
    noun: 'active users from this source',
    total: (i) => i.activeUsersFromSource,
  },
  {
    changeType: 'deactivate_group',
    verb: 'deactivate',
    noun: 'active groups from this source',
    total: (i) => i.activeGroupsFromSource,
  },
  {
    changeType: 'remove_member',
    verb: 'remove',
    noun: 'group memberships from this source',
    total: (i) => i.currentMembershipsFromSource,
  },
];

/**
 * Decides whether a diff is safe to apply.
 *
 * This is the protection against a source outage emptying the directory. It
 * is not advisory: a blocked run will not apply on a schedule whatever
 * `autoApply` says, because an unattended schedule is exactly when nobody is
 * watching. An over-threshold run can be applied by a person who has read the
 * numbers and said so — never by the scheduler.
 */
export function evaluateGuard(input: GuardInput): GuardVerdict {
  // First and unconditional. An empty directory and an unreachable one are
  // indistinguishable, and the safe reading is the second.
  if (input.recordsRead === 0) {
    return {
      blocked: true,
      requiresConfirmation: false,
      reason: 'the source returned no records',
    };
  }

  const tripped: string[] = [];

  for (const population of POPULATIONS) {
    const count = input.changes.filter(
      (c) => c.changeType === population.changeType,
    ).length;
    if (count === 0) continue;

    // No denominator means nothing to protect yet — a first run against a
    // source that owns nothing of this kind.
    const total = population.total(input);
    if (total === 0) continue;

    const share = (count / total) * 100;
    if (share > input.thresholdPercent) {
      tripped.push(
        `would ${population.verb} ${count} of ${total} ${population.noun} ` +
          `(${share.toFixed(1)}%), above the ${input.thresholdPercent}% threshold`,
      );
    }
  }

  if (tripped.length === 0) return { blocked: false };

  return {
    blocked: true,
    requiresConfirmation: true,
    reason: tripped.join('; '),
  };
}
