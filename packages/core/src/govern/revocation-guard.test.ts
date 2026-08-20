import { describe, expect, it } from 'vitest';
import * as barrel from '../index.js';
import { evaluateRevocationGuard, type GuardInput } from './revocation-guard.js';
import { known, unknownValue } from './types.js';

const input = (over: Partial<GuardInput> = {}): GuardInput => ({
  revocationsInBatch: 1,
  holdingsInScope: 100,
  revocationsByResource: new Map(),
  holderCountByResource: new Map(),
  resourceNameById: new Map(),
  thresholds: {
    batchThresholdPercent: 10,
    perResourceThresholdPercent: 30,
    personPopulationDropPercent: 20,
  },
  snapshotAgeDays: 1,
  maxSnapshotAgeDays: 7,
  staleSources: [],
  personsWithActiveContract: 100,
  previousPersonsWithActiveContract: 100,
  hasEverApplied: true,
  ...over,
});

describe('the batch axis, at its boundaries', () => {
  it('proceeds just UNDER the threshold', () => {
    expect(
      evaluateRevocationGuard(input({ revocationsInBatch: 9, holdingsInScope: 100 })).outcome,
    ).toBe('proceed');
  });

  it('proceeds EXACTLY AT the threshold — the comparison is strictly greater', () => {
    // Stated rather than left to a reader: 10 of 100 at a 10% limit is at the
    // limit, not over it, and a guard that fired here would be a guard nobody
    // could configure to allow exactly what they asked for.
    expect(
      evaluateRevocationGuard(input({ revocationsInBatch: 10, holdingsInScope: 100 })).outcome,
    ).toBe('proceed');
  });

  it('requires confirmation just OVER the threshold', () => {
    const verdict = evaluateRevocationGuard(
      input({ revocationsInBatch: 11, holdingsInScope: 100 }),
    );
    expect(verdict.outcome).toBe('requires_confirmation');
    if (verdict.outcome !== 'requires_confirmation') throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('11 of 100');
  });

  it('treats an EMPTY scope as 100%, never as 0%', () => {
    // The empty case, in the safe direction. Dividing by a zero denominator and
    // calling the answer zero waves through the one batch nothing is known
    // about.
    const verdict = evaluateRevocationGuard(
      input({ revocationsInBatch: 1, holdingsInScope: 0 }),
    );
    expect(verdict.outcome).toBe('requires_confirmation');
  });
});

describe('the per-resource axis', () => {
  it('trips while the batch axis does not', () => {
    // 3 of 100 in the batch is 3%, under the 10% batch limit — but all three
    // are holders of one group of four, which is 75%. "This campaign is
    // emptying Finance-Payments" is the sentence most worth interrupting
    // somebody with.
    const verdict = evaluateRevocationGuard(
      input({
        revocationsInBatch: 3,
        holdingsInScope: 100,
        revocationsByResource: new Map([['ent-1', 3]]),
        holderCountByResource: new Map([['ent-1', known(4)]]),
        resourceNameById: new Map([['ent-1', 'Finance-Payments']]),
      }),
    );
    expect(verdict.outcome).toBe('requires_confirmation');
    if (verdict.outcome !== 'requires_confirmation') throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('Finance-Payments');
    expect(verdict.reasons[0]).toContain('3 of 4');
  });

  it('forces confirmation for a resource whose holder count is UNKNOWN', () => {
    // An axis that quietly protects nothing on exactly the resources it exists
    // for is worse than no axis. It is not skipped, and the confirmation names
    // it and the reason.
    const verdict = evaluateRevocationGuard(
      input({
        revocationsByResource: new Map([['ent-1', 1]]),
        holderCountByResource: new Map([
          ['ent-1', unknownValue('the finance target has not been read since Tuesday')],
        ]),
        resourceNameById: new Map([['ent-1', 'Finance-Payments']]),
      }),
    );
    expect(verdict.outcome).toBe('requires_confirmation');
    if (verdict.outcome !== 'requires_confirmation') throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('unknown');
    expect(verdict.reasons[0]).toContain('not been read since Tuesday');
  });

  it('forces confirmation for a resource with NO recorded holders', () => {
    const verdict = evaluateRevocationGuard(
      input({
        revocationsByResource: new Map([['ent-1', 1]]),
        holderCountByResource: new Map([['ent-1', known(0)]]),
        resourceNameById: new Map([['ent-1', 'Finance-Payments']]),
      }),
    );
    expect(verdict.outcome).toBe('requires_confirmation');
  });
});

describe('the four conditions no confirmation can fix', () => {
  it('REFUSES a snapshot past maxSnapshotAgeDays', () => {
    const verdict = evaluateRevocationGuard(input({ snapshotAgeDays: 40, maxSnapshotAgeDays: 7 }));
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('40 days old');
  });

  it('REFUSES when a source has gone stale between decision and execution', () => {
    const verdict = evaluateRevocationGuard(
      input({
        staleSources: [{ sourceName: 'Acme AD', staleness: 'stale', completeness: 'complete' }],
      }),
    );
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('Acme AD');
  });

  it('REFUSES when a source in scope was never read at all', () => {
    const verdict = evaluateRevocationGuard(
      input({
        staleSources: [{ sourceName: 'Payroll', staleness: 'fresh', completeness: 'unread' }],
      }),
    );
    expect(verdict.outcome).toBe('refused');
  });

  it('REFUSES a collapsed person population — the truncated HR import', () => {
    const verdict = evaluateRevocationGuard(
      input({ personsWithActiveContract: 70, previousPersonsWithActiveContract: 100 }),
    );
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('30% fewer');
  });

  it('does NOT refuse a drop at exactly the limit', () => {
    expect(
      evaluateRevocationGuard(
        input({ personsWithActiveContract: 80, previousPersonsWithActiveContract: 100 }),
      ).outcome,
    ).toBe('proceed');
  });

  it('is silent about the population when there is no prior batch to compare against', () => {
    // A null denominator is not a collapse. It is the first batch, which the
    // confirmation axis below catches instead.
    const verdict = evaluateRevocationGuard(
      input({ previousPersonsWithActiveContract: null, hasEverApplied: false }),
    );
    expect(verdict.outcome).toBe('requires_confirmation');
  });
});

describe('the first batch in a tenant', () => {
  it('always requires confirmation, whatever its size', () => {
    // Every denominator is zero and no percentage can say anything about it.
    const verdict = evaluateRevocationGuard(
      input({ revocationsInBatch: 1, holdingsInScope: 10_000, hasEverApplied: false }),
    );
    expect(verdict.outcome).toBe('requires_confirmation');
    if (verdict.outcome !== 'requires_confirmation') throw new Error('unreachable');
    expect(verdict.reasons[0]).toContain('first revocation batch');
  });
});

describe('the barrel', () => {
  it('leaves BOTH guards reachable', () => {
    // TS2308 is the failure that does not raise an error at the site that
    // caused it: a duplicate star export makes the barrel export NEITHER side
    // of the ambiguous name, silently, so Directory Sync's and Provision's
    // guards would disappear from the public surface without a build failing.
    expect(barrel).toHaveProperty('evaluateRevocationGuard');
    expect(barrel).toHaveProperty('evaluateProvisionGuard');
  });
});
