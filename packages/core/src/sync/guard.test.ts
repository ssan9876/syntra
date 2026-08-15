import { describe, expect, it } from 'vitest';
import { evaluateGuard, type GuardInput } from './guard.js';
import type { ChangeType, ProposedChange } from './diff.js';

const changes = (changeType: ChangeType, n: number): ProposedChange[] =>
  Array.from({ length: n }, (_, i) => ({
    changeType,
    targetType: 'User' as const,
    targetId: `t${i}`,
    sourceAnchor: `a${i}`,
    before: { status: 'active' },
    after: { status: 'inactive' },
    status: 'proposed' as const,
  }));

const deactivations = (n: number) => changes('deactivate_user', n);

/** Populations default to empty; each test names only the one it cares about. */
const guard = (overrides: Partial<GuardInput>): GuardInput => ({
  changes: [],
  recordsRead: 100,
  activeUsersFromSource: 0,
  activeGroupsFromSource: 0,
  currentMembershipsFromSource: 0,
  thresholdPercent: 10,
  ...overrides,
});

describe('evaluateGuard', () => {
  it('blocks a run that read nothing, whatever the diff says', () => {
    // An empty directory and an unreachable one are indistinguishable, and
    // the safe reading is the second. Nothing about it is confirmable.
    const verdict = evaluateGuard(
      guard({
        changes: deactivations(100),
        recordsRead: 0,
        activeUsersFromSource: 100,
      }),
    );
    expect(verdict).toEqual({
      blocked: true,
      requiresConfirmation: false,
      reason: 'the source returned no records',
    });
  });

  it('allows a deactivation count under the threshold', () => {
    const verdict = evaluateGuard(
      guard({ changes: deactivations(9), activeUsersFromSource: 100 }),
    );
    expect(verdict).toEqual({ blocked: false });
  });

  it('allows a count exactly at the threshold', () => {
    // "More than" means strictly more; 10 of 100 at a 10% threshold passes.
    const verdict = evaluateGuard(
      guard({ changes: deactivations(10), activeUsersFromSource: 100 }),
    );
    expect(verdict).toEqual({ blocked: false });
  });

  it('blocks a count just over the threshold, and asks for confirmation', () => {
    const verdict = evaluateGuard(
      guard({ changes: deactivations(11), activeUsersFromSource: 100 }),
    );
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.requiresConfirmation).toBe(true);
    expect(verdict.reason).toContain('11');
    expect(verdict.reason).toContain('100');
    expect(verdict.reason).toContain('active users');
  });

  it('allows a run with no deactivations at all', () => {
    const verdict = evaluateGuard(guard({ activeUsersFromSource: 100 }));
    expect(verdict).toEqual({ blocked: false });
  });

  it('allows any deactivation when the source owned nothing yet', () => {
    // First run against a fresh source: no denominator, nothing to protect.
    const verdict = evaluateGuard(
      guard({ changes: deactivations(3), recordsRead: 50 }),
    );
    expect(verdict).toEqual({ blocked: false });
  });

  it('counts only deactivations, not creates and updates', () => {
    const verdict = evaluateGuard(
      guard({
        changes: [...deactivations(5), ...changes('create_user', 50)],
        activeUsersFromSource: 100,
      }),
    );
    expect(verdict).toEqual({ blocked: false });
  });

  it('blocks on a threshold of zero unless nothing is deactivated', () => {
    expect(
      evaluateGuard(
        guard({
          changes: deactivations(1),
          recordsRead: 10,
          activeUsersFromSource: 10,
          thresholdPercent: 0,
        }),
      ).blocked,
    ).toBe(true);
    expect(
      evaluateGuard(
        guard({
          recordsRead: 10,
          activeUsersFromSource: 10,
          thresholdPercent: 0,
        }),
      ).blocked,
    ).toBe(false);
  });
});

describe('evaluateGuard, per population', () => {
  it('allows a group deactivation count under the threshold', () => {
    const verdict = evaluateGuard(
      guard({
        changes: changes('deactivate_group', 1),
        activeGroupsFromSource: 40,
      }),
    );
    expect(verdict).toEqual({ blocked: false });
  });

  it('allows a group count exactly at the threshold', () => {
    const verdict = evaluateGuard(
      guard({
        changes: changes('deactivate_group', 4),
        activeGroupsFromSource: 40,
      }),
    );
    expect(verdict).toEqual({ blocked: false });
  });

  it('blocks a group count just over the threshold', () => {
    const verdict = evaluateGuard(
      guard({
        changes: changes('deactivate_group', 5),
        activeGroupsFromSource: 40,
      }),
    );
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.reason).toContain('active groups');
    expect(verdict.reason).toContain('5 of 40');
  });

  it('blocks a group wipeout that a user-count denominator would have hidden', () => {
    // The wrong-groupFilter case: 40 groups all vanish while 4,000 users are
    // read cleanly. Measured against the user count that is 1%, comfortably
    // under a 10% threshold, and every synced group is deactivated unattended.
    const verdict = evaluateGuard(
      guard({
        changes: changes('deactivate_group', 40),
        recordsRead: 4000,
        activeUsersFromSource: 4000,
        activeGroupsFromSource: 40,
      }),
    );
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.reason).toContain('active groups');
  });

  it('protects groups even when the source owns no users at all', () => {
    // The old guard returned `blocked: false` outright whenever the user count
    // was zero, so a groups-only source had no threshold protection.
    const verdict = evaluateGuard(
      guard({
        changes: changes('deactivate_group', 30),
        activeUsersFromSource: 0,
        activeGroupsFromSource: 40,
      }),
    );
    expect(verdict.blocked).toBe(true);
  });

  it('allows a membership removal count under the threshold', () => {
    const verdict = evaluateGuard(
      guard({
        changes: changes('remove_member', 9),
        currentMembershipsFromSource: 100,
      }),
    );
    expect(verdict).toEqual({ blocked: false });
  });

  it('allows a membership count exactly at the threshold', () => {
    const verdict = evaluateGuard(
      guard({
        changes: changes('remove_member', 10),
        currentMembershipsFromSource: 100,
      }),
    );
    expect(verdict).toEqual({ blocked: false });
  });

  it('blocks a membership count just over the threshold', () => {
    // Membership removals strip group-derived entitlements. They were outside
    // the guard entirely, so autoApply could revoke thousands unattended.
    const verdict = evaluateGuard(
      guard({
        changes: changes('remove_member', 11),
        currentMembershipsFromSource: 100,
      }),
    );
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.reason).toContain('group memberships');
    expect(verdict.reason).toContain('11 of 100');
  });

  it('names every population that tripped, not just the first', () => {
    const verdict = evaluateGuard(
      guard({
        changes: [
          ...deactivations(50),
          ...changes('deactivate_group', 30),
          ...changes('remove_member', 90),
        ],
        activeUsersFromSource: 100,
        activeGroupsFromSource: 40,
        currentMembershipsFromSource: 100,
      }),
    );
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.reason).toContain('active users');
    expect(verdict.reason).toContain('active groups');
    expect(verdict.reason).toContain('group memberships');
  });
});
