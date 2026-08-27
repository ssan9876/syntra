import { populationDropRefusal } from '../identity/population-drop.js';
export interface SweepGuardThresholds {
  sweepThresholdPercent: number;
  perProductSweepThresholdPercent: number;
  personPopulationDropPercent: number;
}

export interface SweepGuardInput {
  /**
   * `application` and `localGroup` removals only. The target half is
   * Provision's guard, thoroughly and on two axes; counting it here would
   * guard the same act twice and block on a number nobody can act on from
   * this screen.
   */
  internalRemovals: number;
  internalGrantsInTenant: number;
  removalsByProduct: ReadonlyMap<string, number>;
  activeGrantsByProduct: ReadonlyMap<string, number>;
  productNameById: ReadonlyMap<string, string>;
  thresholds: SweepGuardThresholds;
  personsWithActiveContract: number;
  /** From the last APPLIED sweep. Null when there has never been one. */
  previousPersonsWithActiveContract: number | null;
  hasEverApplied: boolean;
}

export type SweepGuardVerdict =
  | { blocked: false }
  | { blocked: true; confirmable: boolean; reasons: string[] };

/**
 * Whether a sweep may apply itself.
 *
 * Two axes that make a sweep CONFIRMABLE, and two conditions that block it
 * outright with no confirmation available. The distinction matters: a
 * confirmable sweep is one a human can look at and accept; a blocked one is
 * one whose own inputs are not trustworthy, and confirming it would be
 * confirming a number rather than a decision.
 */
export function evaluateSweepGuard(input: SweepGuardInput): SweepGuardVerdict {
  const hard: string[] = [];
  const soft: string[] = [];

  // The person-register collapse. Refused unconditionally: there is nothing a
  // human could usefully confirm about a sweep whose entire population went
  // missing.
  //
  // `populationDropRefusal` rather than the arithmetic inline. The copy that
  // used to live here divided by `previousPersonsWithActiveContract` without
  // checking it was non-zero, and reached the right answer by way of
  // `-Infinity` failing the comparison. See that function.
  const collapse = populationDropRefusal({
    current: input.personsWithActiveContract,
    previous: input.previousPersonsWithActiveContract,
    thresholdPercent: input.thresholds.personPopulationDropPercent,
    subject: 'sweep',
  });
  if (collapse !== null) hard.push(collapse);

  if (hard.length > 0) return { blocked: true, confirmable: false, reasons: hard };

  // The first sweep in a tenant. Every denominator is zero and no percentage
  // can say anything about it, so a human looks at it once.
  if (!input.hasEverApplied && input.internalRemovals > 0) {
    soft.push(
      `this is the first sweep applied in this tenant, so there is no previous state to compare ${input.internalRemovals} removals against`,
    );
  }

  if (input.internalGrantsInTenant > 0) {
    const share = (input.internalRemovals / input.internalGrantsInTenant) * 100;
    if (share >= input.thresholds.sweepThresholdPercent) {
      soft.push(
        `${input.internalRemovals} of ${input.internalGrantsInTenant} application and group grants would be removed (${share.toFixed(1)}%, threshold ${input.thresholds.sweepThresholdPercent}%)`,
      );
    }
  }

  for (const [productId, removals] of input.removalsByProduct) {
    const holders = input.activeGrantsByProduct.get(productId) ?? 0;
    if (holders === 0) continue;
    const share = (removals / holders) * 100;
    if (share > input.thresholds.perProductSweepThresholdPercent) {
      const name = input.productNameById.get(productId) ?? productId;
      soft.push(
        `${name} would lose ${removals} of its ${holders} holders (${share.toFixed(1)}%, threshold ${input.thresholds.perProductSweepThresholdPercent}%)`,
      );
    }
  }

  return soft.length === 0
    ? { blocked: false }
    : { blocked: true, confirmable: true, reasons: soft };
}
