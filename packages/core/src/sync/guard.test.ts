import { describe, expect, it } from 'vitest';
import { evaluateGuard } from './guard.js';
import type { ProposedChange } from './diff.js';

const deactivations = (n: number): ProposedChange[] =>
  Array.from({ length: n }, (_, i) => ({
    changeType: 'deactivate_user' as const,
    targetType: 'User' as const,
    targetId: `u${i}`,
    sourceAnchor: `a${i}`,
    before: { status: 'active' },
    after: { status: 'inactive' },
    status: 'proposed' as const,
  }));

describe('evaluateGuard', () => {
  it('blocks a run that read nothing, whatever the diff says', () => {
    // An empty directory and an unreachable one are indistinguishable, and
    // the safe reading is the second.
    const verdict = evaluateGuard({
      changes: deactivations(100),
      recordsRead: 0,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({
      blocked: true,
      reason: 'the source returned no records',
    });
  });

  it('allows a deactivation count under the threshold', () => {
    const verdict = evaluateGuard({
      changes: deactivations(9),
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('allows a count exactly at the threshold', () => {
    // "More than" means strictly more; 10 of 100 at a 10% threshold passes.
    const verdict = evaluateGuard({
      changes: deactivations(10),
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('blocks a count just over the threshold', () => {
    const verdict = evaluateGuard({
      changes: deactivations(11),
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.reason).toContain('11');
    expect(verdict.reason).toContain('100');
  });

  it('allows a run with no deactivations at all', () => {
    const verdict = evaluateGuard({
      changes: [],
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('allows any deactivation when the source owned nothing yet', () => {
    // First run against a fresh source: no denominator, nothing to protect.
    const verdict = evaluateGuard({
      changes: [],
      recordsRead: 50,
      activeUsersFromSource: 0,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('counts only deactivations, not creates and updates', () => {
    const verdict = evaluateGuard({
      changes: [
        ...deactivations(5),
        ...Array.from({ length: 50 }, (_, i) => ({
          changeType: 'create_user' as const,
          targetType: 'User' as const,
          targetId: null,
          sourceAnchor: `n${i}`,
          before: null,
          after: {},
          status: 'proposed' as const,
        })),
      ],
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('blocks on a threshold of zero unless nothing is deactivated', () => {
    expect(
      evaluateGuard({
        changes: deactivations(1),
        recordsRead: 10,
        activeUsersFromSource: 10,
        thresholdPercent: 0,
      }).blocked,
    ).toBe(true);
    expect(
      evaluateGuard({
        changes: [],
        recordsRead: 10,
        activeUsersFromSource: 10,
        thresholdPercent: 0,
      }).blocked,
    ).toBe(false);
  });
});
