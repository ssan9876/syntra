import { describe, expect, it } from 'vitest';
import { evaluateSweepGuard, type SweepGuardInput } from './sweep-guard.js';

const thresholds = {
  sweepThresholdPercent: 10,
  perProductSweepThresholdPercent: 50,
  personPopulationDropPercent: 20,
};

const guard = (over: Partial<SweepGuardInput> = {}) =>
  evaluateSweepGuard({
    internalRemovals: 0,
    internalGrantsInTenant: 1000,
    removalsByProduct: new Map(),
    activeGrantsByProduct: new Map(),
    productNameById: new Map(),
    thresholds,
    personsWithActiveContract: 1000,
    previousPersonsWithActiveContract: 1000,
    hasEverApplied: true,
    ...over,
  });

describe('the tenant-wide axis', () => {
  it('passes just under the threshold, and trips exactly at it', () => {
    expect(guard({ internalRemovals: 99 })).toEqual({ blocked: false });
    const at = guard({ internalRemovals: 100 });
    expect(at).toMatchObject({ blocked: true, confirmable: true });
  });

  it('names the count and the share in the reason', () => {
    const verdict = guard({ internalRemovals: 250 });
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('250');
    expect(verdict.reasons[0]).toContain('25');
  });

  it('counts only internal removals; the target half is Provision guard', () => {
    // Provision's guard already covers grants, revocations, disables and
    // archives at the target, on two axes. Counting them here would guard the
    // same act twice and block on a number nobody can act on from this screen.
    expect(guard({ internalRemovals: 0, internalGrantsInTenant: 10 })).toEqual({
      blocked: false,
    });
  });
});

describe('the per-product axis', () => {
  it('trips when one product loses more than half its holders, even at tenant scale', () => {
    // Emptying one product of its 90 holders is 0.2% of a large tenant and
    // total for the 90.
    const verdict = guard({
      internalRemovals: 90,
      internalGrantsInTenant: 40_000,
      removalsByProduct: new Map([['p1', 90]]),
      activeGrantsByProduct: new Map([['p1', 90]]),
      productNameById: new Map([['p1', 'Finance folder']]),
    });
    expect(verdict).toMatchObject({ blocked: true, confirmable: true });
    if (!verdict.blocked) throw new Error('unreachable');
    // The product BY NAME. "50% of one product" with no name is a number
    // nobody can check.
    expect(verdict.reasons.join(' ')).toContain('Finance folder');
  });

  it('does not trip at exactly half', () => {
    expect(
      guard({
        internalRemovals: 5,
        removalsByProduct: new Map([['p1', 5]]),
        activeGrantsByProduct: new Map([['p1', 10]]),
        productNameById: new Map([['p1', 'Half']]),
      }),
    ).toEqual({ blocked: false });
  });

  it('skips a product with no active grants rather than dividing by zero', () => {
    expect(
      guard({
        internalRemovals: 1,
        removalsByProduct: new Map([['p1', 1]]),
        activeGrantsByProduct: new Map([['p1', 0]]),
      }),
    ).toEqual({ blocked: false });
  });
});

describe('the two conditions that block outright', () => {
  it('refuses when the person population has collapsed, with no confirmation available', () => {
    // Every lapse action is downstream of that count, and a truncated HR
    // import is the accident most likely to produce a sweep that revokes
    // everything.
    const verdict = guard({
      personsWithActiveContract: 700,
      previousPersonsWithActiveContract: 1000,
    });
    expect(verdict).toMatchObject({ blocked: true, confirmable: false });
  });

  it('does not refuse a drop inside the threshold', () => {
    expect(
      guard({ personsWithActiveContract: 850, previousPersonsWithActiveContract: 1000 }),
    ).toEqual({ blocked: false });
  });

  it('refuses a tenant with no persons at all, unconditionally', () => {
    const verdict = guard({
      personsWithActiveContract: 0,
      previousPersonsWithActiveContract: null,
      hasEverApplied: false,
    });
    expect(verdict).toMatchObject({ blocked: true, confirmable: false });
  });

  it('makes the first sweep in a tenant confirmable regardless of size', () => {
    // Every denominator is zero and no percentage can say anything about it.
    // This is the hole Provision found in Directory Sync's guard, closed here
    // at the start.
    const verdict = guard({
      internalRemovals: 1,
      hasEverApplied: false,
      previousPersonsWithActiveContract: null,
    });
    expect(verdict).toMatchObject({ blocked: true, confirmable: true });
  });

  it('does not confuse a first sweep with a collapsed population', () => {
    const verdict = guard({
      internalRemovals: 1,
      hasEverApplied: false,
      previousPersonsWithActiveContract: null,
      personsWithActiveContract: 1000,
    });
    if (!verdict.blocked) throw new Error('unreachable');
    expect(verdict.confirmable).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('first');
  });
});
