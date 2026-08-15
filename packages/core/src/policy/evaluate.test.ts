import { describe, expect, it } from 'vitest';
import { evaluatePolicy, ruleMatches } from './evaluate.js';
import type { AuthContext, PolicyFallback, PolicyRule } from './types.js';

const ALLOW: PolicyFallback = { outcome: 'allow', factorType: null };

let seq = 0;
const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  id: `rule-${++seq}`,
  name: `Rule ${seq}`,
  enabled: true,
  position: seq,
  outcome: 'deny',
  factorType: null,
  applicationIds: [],
  groupIds: [],
  contractField: null,
  contractValues: [],
  ipRanges: [],
  daysOfWeek: [],
  startMinute: null,
  endMinute: null,
  timezone: null,
  ...over,
});

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'user-1',
  applicationId: null,
  groupIds: [],
  contracts: [],
  sourceIp: '10.1.2.3',
  now: new Date('2026-08-12T09:00:00Z'),
  ...over,
});

describe('evaluatePolicy', () => {
  it('falls back when there are no rules', () => {
    expect(evaluatePolicy([], ALLOW, ctx())).toEqual({
      outcome: 'allow',
      factorType: null,
      ruleId: null,
      ruleName: null,
    });
  });

  it('falls back to a require_factor default', () => {
    const fallback: PolicyFallback = { outcome: 'require_factor', factorType: 'webauthn' };
    expect(evaluatePolicy([], fallback, ctx())).toEqual({
      outcome: 'require_factor',
      factorType: 'webauthn',
      ruleId: null,
      ruleName: null,
    });
  });

  it('takes the first matching rule and stops', () => {
    const first = rule({ position: 1, outcome: 'require_mfa' });
    const second = rule({ position: 2, outcome: 'deny' });
    const decision = evaluatePolicy([first, second], ALLOW, ctx());
    expect(decision.outcome).toBe('require_mfa');
    expect(decision.ruleId).toBe(first.id);
  });

  it('evaluates in position order regardless of array order', () => {
    const later = rule({ position: 9, outcome: 'deny' });
    const earlier = rule({ position: 1, outcome: 'allow' });
    const decision = evaluatePolicy([later, earlier], ALLOW, ctx());
    expect(decision.ruleId).toBe(earlier.id);
  });

  it('skips a disabled rule', () => {
    const off = rule({ position: 1, outcome: 'deny', enabled: false });
    expect(evaluatePolicy([off], ALLOW, ctx()).outcome).toBe('allow');
  });

  it('matches on group membership', () => {
    const r = rule({ outcome: 'require_mfa', groupIds: ['g-finance'] });
    expect(evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-finance'] })).outcome).toBe(
      'require_mfa',
    );
    expect(evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-care'] })).outcome).toBe('allow');
  });

  it('matches when the user is in any one of several named groups', () => {
    const r = rule({ outcome: 'deny', groupIds: ['g-a', 'g-b'] });
    expect(evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-b'] })).outcome).toBe('deny');
  });

  it('matches on the target application', () => {
    const r = rule({ outcome: 'require_factor', factorType: 'webauthn', applicationIds: ['app-1'] });
    expect(evaluatePolicy([r], ALLOW, ctx({ applicationId: 'app-1' })).outcome).toBe(
      'require_factor',
    );
    expect(evaluatePolicy([r], ALLOW, ctx({ applicationId: 'app-2' })).outcome).toBe('allow');
  });

  it('does not match an application-scoped rule when there is no application', () => {
    // Signing in to the portal is not signing in to any application, so a rule
    // written about one application must not govern it.
    const r = rule({ outcome: 'deny', applicationIds: ['app-1'] });
    expect(evaluatePolicy([r], ALLOW, ctx({ applicationId: null })).outcome).toBe('allow');
  });

  it('matches a contract condition when any active contract satisfies it', () => {
    const r = rule({
      outcome: 'require_mfa',
      contractField: 'department',
      contractValues: ['Finance'],
    });
    const twoContracts = ctx({
      contracts: [
        { department: 'Care', jobTitle: null, employer: null, location: null },
        { department: 'Finance', jobTitle: null, employer: null, location: null },
      ],
    });
    expect(evaluatePolicy([r], ALLOW, twoContracts).outcome).toBe('require_mfa');
  });

  it('does not match a contract condition when no active contract satisfies it', () => {
    const r = rule({
      outcome: 'require_mfa',
      contractField: 'department',
      contractValues: ['Finance'],
    });
    const ended = ctx({
      contracts: [{ department: 'Care', jobTitle: null, employer: null, location: null }],
    });
    expect(evaluatePolicy([r], ALLOW, ended).outcome).toBe('allow');
  });

  it('does not match a contract condition for a person with no active contract', () => {
    const r = rule({
      outcome: 'require_mfa',
      contractField: 'department',
      contractValues: ['Finance'],
    });
    expect(evaluatePolicy([r], ALLOW, ctx({ contracts: [] })).outcome).toBe('allow');
  });

  it('compares contract values case-insensitively and ignoring surrounding space', () => {
    const r = rule({
      outcome: 'deny',
      contractField: 'jobTitle',
      contractValues: ['Registered Nurse'],
    });
    const messy = ctx({
      contracts: [
        { department: null, jobTitle: '  registered nurse ', employer: null, location: null },
      ],
    });
    expect(evaluatePolicy([r], ALLOW, messy).outcome).toBe('deny');
  });

  it('does not match a contract condition against a null field', () => {
    const r = rule({ outcome: 'deny', contractField: 'employer', contractValues: ['Acme'] });
    const noEmployer = ctx({
      contracts: [{ department: 'Care', jobTitle: null, employer: null, location: null }],
    });
    expect(evaluatePolicy([r], ALLOW, noEmployer).outcome).toBe('allow');
  });

  it('matches on source address', () => {
    const r = rule({ outcome: 'allow', ipRanges: ['10.0.0.0/8'] });
    expect(evaluatePolicy([r], { outcome: 'deny', factorType: null }, ctx()).outcome).toBe(
      'allow',
    );
    const offsite = ctx({ sourceIp: '203.0.113.9' });
    expect(
      evaluatePolicy([r], { outcome: 'deny', factorType: null }, offsite).outcome,
    ).toBe('deny');
  });

  it('matches on a time window', () => {
    const r = rule({ outcome: 'deny', startMinute: 22 * 60, endMinute: 6 * 60 });
    expect(evaluatePolicy([r], ALLOW, ctx({ now: new Date('2026-08-12T23:00:00Z') })).outcome).toBe(
      'deny',
    );
    expect(evaluatePolicy([r], ALLOW, ctx({ now: new Date('2026-08-12T12:00:00Z') })).outcome).toBe(
      'allow',
    );
  });

  it('requires every condition a rule sets, not just one', () => {
    const r = rule({
      outcome: 'deny',
      groupIds: ['g-finance'],
      ipRanges: ['203.0.113.0/24'],
    });
    // In the group, but on the office network: the address condition fails.
    expect(evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-finance'] })).outcome).toBe('allow');
    // Both hold.
    const both = ctx({ groupIds: ['g-finance'], sourceIp: '203.0.113.9' });
    expect(evaluatePolicy([r], ALLOW, both).outcome).toBe('deny');
  });

  it('carries the deciding rule name so a denial can be explained', () => {
    const r = rule({ name: 'Block offsite finance', outcome: 'deny', groupIds: ['g-finance'] });
    const decision = evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-finance'] }));
    expect(decision.ruleName).toBe('Block offsite finance');
    expect(decision.ruleId).toBe(r.id);
  });

  it('carries the required factor for a require_factor outcome', () => {
    const r = rule({ outcome: 'require_factor', factorType: 'webauthn' });
    expect(evaluatePolicy([r], ALLOW, ctx())).toMatchObject({
      outcome: 'require_factor',
      factorType: 'webauthn',
    });
  });

  it('degrades a require_factor rule with no factor type to require_mfa', () => {
    // Write-time validation refuses this shape; if a row is corrupt anyway,
    // demanding *some* factor is the safe reading. It must never silently
    // become an allow.
    const r = rule({ outcome: 'require_factor', factorType: null });
    expect(evaluatePolicy([r], ALLOW, ctx())).toMatchObject({
      outcome: 'require_mfa',
      factorType: null,
    });
  });

  it('does not let a broken condition stop a deny rule applying', () => {
    // The only fail-closed branch in the engine. A malformed range in a rule
    // written to refuse people must not silently turn into "refuse nobody".
    const broken = rule({ outcome: 'deny', ipRanges: ['203.0.113.0/99'] });
    expect(evaluatePolicy([broken], ALLOW, ctx()).outcome).toBe('deny');

    // The same broken condition on an allow rule does not match, so the rule
    // does not let anyone past a condition it cannot check.
    const permissive = rule({ outcome: 'allow', ipRanges: ['203.0.113.0/99'] });
    expect(
      evaluatePolicy([permissive], { outcome: 'deny', factorType: null }, ctx()).outcome,
    ).toBe('deny');
  });

  it('denies when there is no source address to test a deny rule against', () => {
    const offsite = rule({ outcome: 'deny', ipRanges: ['203.0.113.0/24'] });
    // A request whose origin could not be determined is not evidence that it
    // came from somewhere allowed.
    expect(evaluatePolicy([offsite], ALLOW, ctx({ sourceIp: null })).outcome).toBe('deny');
  });

  it('does not let an unresolvable timezone stop a deny rule applying', () => {
    const nights = rule({
      outcome: 'deny',
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      timezone: 'Middle/Earth',
    });
    expect(evaluatePolicy([nights], ALLOW, ctx()).outcome).toBe('deny');
  });

  it('still evaluates a deny rule normally when its conditions are readable', () => {
    // Fail-closed is a backstop, not a shortcut: a well-formed deny rule that
    // simply does not match must still not match.
    const offsite = rule({ outcome: 'deny', ipRanges: ['203.0.113.0/24'] });
    expect(evaluatePolicy([offsite], ALLOW, ctx({ sourceIp: '10.1.2.3' })).outcome).toBe(
      'allow',
    );
  });

  it('exposes the per-rule match so the console can preview it', () => {
    const r = rule({ outcome: 'deny', groupIds: ['g-finance'] });
    expect(ruleMatches(r, ctx({ groupIds: ['g-finance'] }))).toBe(true);
    expect(ruleMatches(r, ctx({ groupIds: ['g-care'] }))).toBe(false);
  });

  it('is a pure function of its arguments', () => {
    const r = rule({ outcome: 'deny', groupIds: ['g-finance'] });
    const context = ctx({ groupIds: ['g-finance'] });
    const first = evaluatePolicy([r], ALLOW, context);
    const second = evaluatePolicy([r], ALLOW, context);
    expect(first).toEqual(second);
    expect(context.groupIds).toEqual(['g-finance']);
  });
});
