import { known, type Tri } from './types.js';

export interface GuardThresholds {
  batchThresholdPercent: number;
  perResourceThresholdPercent: number;
  personPopulationDropPercent: number;
}

export interface GuardInput {
  revocationsInBatch: number;
  holdingsInScope: number;
  revocationsByResource: ReadonlyMap<string, number>;
  /** `unknown` where a coverage gap makes the denominator unknowable. */
  holderCountByResource: ReadonlyMap<string, Tri<number>>;
  resourceNameById: ReadonlyMap<string, string>;
  thresholds: GuardThresholds;
  snapshotAgeDays: number;
  maxSnapshotAgeDays: number;
  staleSources: { sourceName: string; staleness: string; completeness: string }[];
  personsWithActiveContract: number;
  previousPersonsWithActiveContract: number | null;
  hasEverApplied: boolean;
}

export type GuardVerdict =
  | { outcome: 'proceed' }
  | { outcome: 'requires_confirmation'; reasons: string[] }
  | { outcome: 'refused'; reasons: string[] };

/**
 * Two axes, and THREE conditions that block outright with no confirmation
 * available.
 *
 * The per-resource axis is lower than Provision's 50% because a campaign is a
 * deliberate act with a human on the other end of the confirmation, and "this
 * campaign is emptying Finance-Payments" is the single sentence most worth
 * interrupting somebody with.
 */
export function evaluateRevocationGuard(input: GuardInput): GuardVerdict {
  const refusals: string[] = [];

  // 1. There is nothing an administrator could usefully confirm about executing
  //    decisions made against a picture of the world from six weeks ago.
  if (input.snapshotAgeDays > input.maxSnapshotAgeDays) {
    refusals.push(
      `the snapshot these decisions were made against is ${input.snapshotAgeDays} days old, past the limit of ${input.maxSnapshotAgeDays}. Re-base and let the reviewers look at what changed.`,
    );
  }

  // 2. Dispatching a revocation of a holding nobody has confirmed still exists
  //    is how a campaign revokes something that was already gone and reports it
  //    as its own work.
  const offending = input.staleSources.filter(
    (s) => s.staleness === 'stale' || s.completeness === 'unread',
  );
  if (offending.length > 0) {
    refusals.push(
      `a source in this batch's scope is no longer current: ${offending.map((s) => s.sourceName).join(', ')}`,
    );
  }

  // 3. A truncated HR import makes everybody look like a leaver, and a campaign
  //    running over that data revokes the organization.
  if (
    input.previousPersonsWithActiveContract !== null &&
    input.previousPersonsWithActiveContract > 0
  ) {
    const drop =
      ((input.previousPersonsWithActiveContract - input.personsWithActiveContract) /
        input.previousPersonsWithActiveContract) *
      100;
    if (drop > input.thresholds.personPopulationDropPercent) {
      refusals.push(
        `${Math.round(drop)}% fewer persons hold an active contract than at the last applied batch (${input.personsWithActiveContract} against ${input.previousPersonsWithActiveContract})`,
      );
    }
  }

  if (refusals.length > 0) return { outcome: 'refused', reasons: refusals };

  const reasons: string[] = [];

  // 4. THE FIRST BATCH IN A TENANT always requires confirmation regardless of
  //    size, because every denominator is zero and no percentage can say
  //    anything about it.
  if (!input.hasEverApplied) {
    reasons.push(
      'this is the first revocation batch in this tenant, so there is no prior state for a percentage to be a share of',
    );
  }

  const batchShare =
    input.holdingsInScope === 0 ? 100 : (input.revocationsInBatch / input.holdingsInScope) * 100;
  if (batchShare > input.thresholds.batchThresholdPercent) {
    reasons.push(
      `this batch revokes ${input.revocationsInBatch} of ${input.holdingsInScope} holdings in the campaign's scope (${Math.round(batchShare)}%, above ${input.thresholds.batchThresholdPercent}%)`,
    );
  }

  for (const [resourceId, count] of input.revocationsByResource) {
    const name = input.resourceNameById.get(resourceId) ?? resourceId;
    const holders = input.holderCountByResource.get(resourceId) ?? known(0);

    // A resource whose holder count is UNKNOWN cannot be divided. It is not
    // skipped: an axis that quietly protects nothing on exactly the resources
    // it exists for is worse than no axis, and the confirmation names it.
    if (!holders.known) {
      reasons.push(
        `the current holder count of "${name}" is unknown (${holders.reason}), so this batch's share of it cannot be computed`,
      );
      continue;
    }
    if (holders.value === 0) {
      reasons.push(
        `"${name}" has no recorded holders, so this batch's share of it cannot be computed`,
      );
      continue;
    }
    const share = (count / holders.value) * 100;
    if (share > input.thresholds.perResourceThresholdPercent) {
      reasons.push(
        `this batch revokes ${count} of ${holders.value} holders of "${name}" (${Math.round(share)}%, above ${input.thresholds.perResourceThresholdPercent}%)`,
      );
    }
  }

  return reasons.length > 0 ? { outcome: 'requires_confirmation', reasons } : { outcome: 'proceed' };
}
