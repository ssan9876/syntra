import type { ProvisionActionType } from '@syntra/connectors';
import type { PlannedAction } from './types.js';

export interface GuardThresholds {
  createAccountThresholdPercent: number;
  disableAccountThresholdPercent: number;
  archiveAccountThresholdPercent: number;
  revokeEntitlementThresholdPercent: number;
  deactivateSyntraUserThresholdPercent: number;
  perEntitlementThresholdPercent: number;
  personPopulationDropPercent: number;
}

export interface GuardInput {
  actions: PlannedAction[];
  thresholds: GuardThresholds;
  accountsAtTarget: number;
  activeAccountsAtTarget: number;
  entitlementHoldingsAtTarget: number;
  activeSyntraUsersLinked: number;
  /**
   * That entitlement's own CURRENT HOLDER COUNT AT THE TARGET, not Syntra's
   * record of what it granted (spec section 11).
   *
   * The distinction is the whole second axis. Counting `AccountEntitlement`
   * rows measures what Provision believes it did, and on a target Provision
   * has not applied to yet -- or whose inventory has come apart, which is the
   * condition drift exists to report -- every count is zero. The run builds
   * this from the reconciled target inventory (Task 13).
   *
   * A missing or zero entry is NOT a pass. `plan.ts` proposes a revocation
   * only for an entitlement in `heldWithinRemit`, which `reconcile.ts` builds
   * as a subset of what the target returned for the account, so one proposed
   * revocation means at least one holder at the target. A zero denominator
   * against a non-zero revocation count therefore means the map and the plan
   * did not come from the same inventory, and the axis cannot be evaluated at
   * all. See `cannotEvaluate` below.
   */
  holderCountByEntitlement: ReadonlyMap<string, number>;
  entitlementNameById: ReadonlyMap<string, string>;
  personsWithActiveContract: number;
  /** Null on a first run; the test is skipped then. */
  previousPersonsWithActiveContract: number | null;
  hasEverApplied: boolean;
}

export type GuardVerdict =
  | { blocked: false }
  /**
   * `requiresConfirmation` separates the two refusals. A run whose target
   * returned nothing, whose person population collapsed, or one of whose axes
   * cannot be evaluated at all, is refused outright: there is nothing an
   * administrator could usefully confirm about a directory that may simply be
   * unreachable, an HR feed that may be truncated, or a percentage whose
   * denominator is missing. A run over a threshold is refused *pending*
   * confirmation, because a real cohort departure has to be processable.
   */
  | { blocked: true; requiresConfirmation: boolean; reasons: string[] };

interface Population {
  actionType: ProvisionActionType;
  verb: string;
  noun: string;
  total(input: GuardInput): number;
  threshold(t: GuardThresholds): number;
}

/**
 * Every consequential action type is its own population with its own
 * denominator.
 *
 * Directory Sync learned the hard way that a guard which counts only the
 * obvious population misses the dangerous one: membership removals sat
 * entirely outside it while user deactivations were carefully gated, and a
 * wrong group filter could empty every group in a tenant while sailing under
 * the user threshold.
 *
 * Absent from this list, deliberately: update_account, enable_account,
 * grant_entitlement, rename_account and reactivate_syntra_user. They are
 * additive or corrective, and a mass grant, while undesirable, is visible in
 * the plan and reversible by the next run.
 */
const POPULATIONS: Population[] = [
  {
    actionType: 'create_account',
    verb: 'create',
    noun: 'accounts',
    total: (i) => i.accountsAtTarget,
    threshold: (t) => t.createAccountThresholdPercent,
  },
  {
    actionType: 'disable_account',
    verb: 'disable',
    noun: 'active accounts',
    total: (i) => i.activeAccountsAtTarget,
    threshold: (t) => t.disableAccountThresholdPercent,
  },
  {
    actionType: 'archive_account',
    verb: 'archive',
    noun: 'accounts',
    total: (i) => i.accountsAtTarget,
    threshold: (t) => t.archiveAccountThresholdPercent,
  },
  {
    actionType: 'revoke_entitlement',
    verb: 'revoke',
    noun: 'entitlement holdings',
    total: (i) => i.entitlementHoldingsAtTarget,
    threshold: (t) => t.revokeEntitlementThresholdPercent,
  },
  {
    actionType: 'deactivate_syntra_user',
    verb: 'deactivate',
    noun: 'active Syntra users linked to this target',
    total: (i) => i.activeSyntraUsersLinked,
    threshold: (t) => t.deactivateSyntraUserThresholdPercent,
  },
];

/**
 * The action types measured against a threshold, in the order they are
 * reported. Exported so a test can assert that the set of guarded types and
 * the set of deliberately unguarded ones together cover
 * `ProvisionActionType` exhaustively — a new action type must not be able to
 * arrive silently unguarded.
 */
export const GUARDED_ACTION_TYPES: readonly ProvisionActionType[] = POPULATIONS.map(
  (p) => p.actionType,
);

const THRESHOLD_KEYS = [
  'createAccountThresholdPercent',
  'disableAccountThresholdPercent',
  'archiveAccountThresholdPercent',
  'revokeEntitlementThresholdPercent',
  'deactivateSyntraUserThresholdPercent',
  'perEntitlementThresholdPercent',
  'personPopulationDropPercent',
] as const satisfies readonly (keyof GuardThresholds)[];

const COUNT_KEYS = [
  'accountsAtTarget',
  'activeAccountsAtTarget',
  'entitlementHoldingsAtTarget',
  'activeSyntraUsersLinked',
  'personsWithActiveContract',
] as const satisfies readonly (keyof GuardInput)[];

/** A percentage this guard can compare against. */
const isPercent = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 100;

/** A population size this guard can divide by. */
const isCount = (value: number): boolean => Number.isFinite(value) && value >= 0;

/**
 * Decides whether a plan may be applied at all.
 *
 * It is a pure function of the plan and a set of counts, it is not advisory,
 * and `autoApply` does not override it — there is deliberately no input by
 * which a caller could waive it, because an unattended schedule is exactly the
 * case it exists for. Confirmation is per run, by a person who has read the
 * numbers; the scheduler never confirms anything.
 *
 * It fails closed everywhere. Every refusal in here is reachable by a run that
 * would otherwise apply, and the failure direction of every branch is "refuse"
 * rather than "skip": a guard that silently declines to evaluate an axis is
 * indistinguishable from a guard that has been switched off, and that is the
 * defect this control has already shipped once.
 */
export function evaluateProvisionGuard(input: GuardInput): GuardVerdict {
  const hard: string[] = [];

  // Before anything is compared, check that the numbers can be compared.
  //
  // A NaN threshold makes every `share > threshold` false and a NaN
  // denominator makes every share NaN, so a single bad configuration value
  // turns the whole guard into a function that returns `{ blocked: false }`
  // for every run ever proposed — while continuing to look, at every call
  // site and in every API response, exactly like a guard. Refused rather than
  // clamped: a threshold nobody can state is not a threshold.
  for (const key of THRESHOLD_KEYS) {
    const value = input.thresholds[key];
    if (!isPercent(value)) {
      hard.push(
        `the ${key} threshold is ${value}, which is not a percentage between 0 and 100; a guard cannot compare a share against a value it cannot compare against`,
      );
    }
  }
  for (const key of COUNT_KEYS) {
    const value = input[key];
    if (!isCount(value)) {
      hard.push(
        `${key} is ${value}, which is not a population count; the guard has nothing to measure this run against`,
      );
    }
  }
  if (
    input.previousPersonsWithActiveContract !== null &&
    !isCount(input.previousPersonsWithActiveContract)
  ) {
    hard.push(
      `previousPersonsWithActiveContract is ${input.previousPersonsWithActiveContract}, which is not a population count; the guard has nothing to measure this run against`,
    );
  }
  if (hard.length > 0) {
    return { blocked: true, requiresConfirmation: false, reasons: hard };
  }

  // A run with no persons at all is refused unconditionally, before anything
  // else: it is upstream of every leaver action in the plan.
  if (input.personsWithActiveContract === 0) {
    hard.push(
      'this run found no persons holding an active contract at all, which is upstream of every leaver action a plan could contain',
    );
  } else if (input.previousPersonsWithActiveContract !== null) {
    const previous = input.previousPersonsWithActiveContract;
    if (previous > 0) {
      const drop = ((previous - input.personsWithActiveContract) / previous) * 100;
      if (drop > input.thresholds.personPopulationDropPercent) {
        hard.push(
          `the number of persons holding an active contract has fallen from ${previous} to ${input.personsWithActiveContract} (${drop.toFixed(1)}%), above the ${input.thresholds.personPopulationDropPercent}% limit; this is the signature of a broken HR feed`,
        );
      }
    }
  }

  // An empty target and an unreachable one look identical from here.
  if (input.accountsAtTarget === 0 && input.hasEverApplied) {
    hard.push(
      `the target returned no accounts at all while Syntra holds ${input.activeAccountsAtTarget} for it; an empty target and an unreachable one look identical, and the safe reading is the second`,
    );
  }

  if (hard.length > 0) {
    return { blocked: true, requiresConfirmation: false, reasons: hard };
  }

  // A first run has a denominator of zero for every population, so no
  // percentage can say anything about it. Directory Sync's guard skips a
  // population with no denominator, which is right for a sync and not right
  // for a first mass create.
  if (!input.hasEverApplied) {
    return {
      blocked: true,
      requiresConfirmation: true,
      reasons: [
        'this target has never had a run applied, so every population has a denominator of zero and no threshold can say anything about it',
      ],
    };
  }

  /**
   * Axes whose denominator is missing while the plan proposes actions on
   * them. Not the same as a tripped threshold and not confirmable: the
   * percentage was never computed, so there is no number for anybody to
   * confirm having read.
   */
  const cannotEvaluate: string[] = [];
  const tripped: string[] = [];

  for (const population of POPULATIONS) {
    const count = input.actions.filter(
      (a) => a.actionType === population.actionType,
    ).length;
    // Nothing proposed on this axis. The genuinely empty case: a target with
    // no linked Syntra users and no deactivations in the plan is not a run
    // that cannot be evaluated, it is a run with nothing to evaluate.
    if (count === 0) continue;

    const total = population.total(input);
    if (total === 0) {
      // The plan proposes work on a population the inventory says is empty.
      // The two came from the same read, so one of them is wrong, and the
      // arithmetic that would have caught a mass action divides by zero. This
      // is the shape the pre-flight found: entitlement holdings counted from
      // a field the connector never populated, `continue`, and the
      // most-emphasised control in the spec silently off.
      cannotEvaluate.push(
        `cannot evaluate the ${population.verb} axis: the plan would ${population.verb} ${count} ${population.noun} while the target inventory reports none at all, so the plan and the denominator did not come from the same read`,
      );
      continue;
    }

    const share = (count / total) * 100;
    const threshold = population.threshold(input.thresholds);
    if (share > threshold) {
      tripped.push(
        `would ${population.verb} ${count} of ${total} ${population.noun} (${share.toFixed(1)}%), above the ${threshold}% threshold`,
      );
    }
  }

  // The second axis. Revoking every holder of one entitlement is the exact
  // signature of a rule that stopped matching -- a renamed department, a
  // changed job title string, a mistyped condition -- and in a tenant with
  // 40,000 holdings across 300 groups, emptying one group of its 90 members
  // is 0.2% of the total.
  const revocationsByEntitlement = new Map<string, number>();
  for (const action of input.actions) {
    if (action.actionType !== 'revoke_entitlement') continue;
    // Nothing produces one, and a null id belongs to no denominator. It must
    // not become a bucket of its own keyed on "null".
    if (action.entitlementId === null) continue;
    revocationsByEntitlement.set(
      action.entitlementId,
      (revocationsByEntitlement.get(action.entitlementId) ?? 0) + 1,
    );
  }

  for (const [entitlementId, count] of revocationsByEntitlement) {
    const name = input.entitlementNameById.get(entitlementId) ?? entitlementId;
    const holders = input.holderCountByEntitlement.get(entitlementId);

    // Zero holders, an absent entry and a value that is not a count are one
    // fault in three costumes, and all three are refusals rather than passes.
    //
    // A revocation exists only for an entitlement the target returned for the
    // account (`reconcile.ts` builds `heldWithinRemit` from
    // `object.entitlementIds`; `plan.ts` iterates it), so one revocation
    // implies at least one holder. A denominator of zero against a non-zero
    // count means the holder map was not built from the inventory that
    // produced these actions — and it is exactly then, when the inventory has
    // come apart, that this axis is the only thing standing between a
    // mistyped condition and an emptied group.
    if (holders === undefined || !isCount(holders) || holders === 0) {
      const observed =
        holders === undefined
          ? 'the target inventory carries no holder count at all for it'
          : `the target inventory reports ${holders} holders for it`;
      cannotEvaluate.push(
        `cannot evaluate the per-entitlement axis for "${name}": the plan would revoke it from ${count} holders while ${observed}, so the plan and the denominator did not come from the same read`,
      );
      continue;
    }

    const share = (count / holders) * 100;
    if (share > input.thresholds.perEntitlementThresholdPercent) {
      tripped.push(
        `would revoke "${name}" from ${count} of ${holders} holders (${share.toFixed(1)}%), above the ${input.thresholds.perEntitlementThresholdPercent}% per-entitlement threshold`,
      );
    }
  }

  // An axis that could not be evaluated outranks one that merely tripped:
  // the run is refused outright, and the thresholds that were computable are
  // still reported so the administrator sees the whole picture rather than
  // fixing the inventory only to meet a second refusal.
  if (cannotEvaluate.length > 0) {
    return {
      blocked: true,
      requiresConfirmation: false,
      reasons: [...cannotEvaluate, ...tripped],
    };
  }

  if (tripped.length === 0) return { blocked: false };
  return { blocked: true, requiresConfirmation: true, reasons: tripped };
}
