import { describe, expect, it } from 'vitest';
import {
  evaluateSodRule,
  evaluateSodRules,
  sodImpact,
  type PersonHolding,
  type SodRuleFacts,
} from './sod.js';

const raise = {
  functionId: 'fn-raise',
  name: 'Raise a payment',
  resources: [
    { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'ent-ap-entry' },
    { systemId: 'saas', resourceKind: 'application' as const, resourceId: 'app-pay' },
  ],
};
const approve = {
  functionId: 'fn-approve',
  name: 'Approve a payment',
  resources: [
    { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'ent-ap-approve' },
  ],
};

const rule: SodRuleFacts = {
  ruleId: 'rule-1',
  name: 'Payment raising and approval',
  functionA: raise,
  functionB: approve,
  severity: 'critical',
  enabled: true,
};

const holding = (over: Partial<PersonHolding>): PersonHolding => ({
  systemId: 'ad',
  resourceKind: 'targetEntitlement',
  resourceId: 'ent-ap-entry',
  resourceName: 'AP entry',
  contractIds: ['c-1'],
  ...over,
});

describe('evaluateSodRule', () => {
  it('is clear when the person holds only one side', () => {
    expect(evaluateSodRule(rule, [holding({})], []).kind).toBe('clear');
  });

  it('is clear when the person holds nothing at all', () => {
    // The empty case, in the safe direction: no holdings is no violation, and a
    // rule that fired on an empty set would put the whole tenant on the board.
    expect(evaluateSodRule(rule, [], []).kind).toBe('clear');
  });

  it('finds a violation ACROSS TWO SYSTEMS and two accounts of one person', () => {
    // The classic real violation: somebody raises payments with their ordinary
    // account and approves them with an administrative one. No single-system
    // check has ever caught that.
    const outcome = evaluateSodRule(
      rule,
      [
        holding({
          systemId: 'saas',
          resourceKind: 'application',
          resourceId: 'app-pay',
          resourceName: 'Pay portal',
        }),
        holding({ resourceId: 'ent-ap-approve', resourceName: 'AP approve' }),
      ],
      [],
    );
    expect(outcome.kind).toBe('violation');
    if (outcome.kind !== 'violation') throw new Error('unreachable');
    expect(outcome.holdingsA.map((h) => h.resourceName)).toEqual(['Pay portal']);
    expect(outcome.holdingsB.map((h) => h.resourceName)).toEqual(['AP approve']);
  });

  it('records the CONTRACTS that produced each side', () => {
    // A person with concurrent contracts may legitimately hold both sides, and
    // an exception whose basis is "these are two separate engagements" is a
    // real justification — which lapses when one of those contracts does.
    const outcome = evaluateSodRule(
      rule,
      [
        holding({ contractIds: ['c-teaching'] }),
        holding({ resourceId: 'ent-ap-approve', contractIds: ['c-research'] }),
      ],
      [],
    );
    if (outcome.kind !== 'violation') throw new Error('unreachable');
    expect(outcome.contractsA).toEqual(['c-teaching']);
    expect(outcome.contractsB).toEqual(['c-research']);
  });

  it('is UNEVALUABLE when a function’s resource is missing, never clear', () => {
    // Quietly evaluating without it produces a confident wrong answer in the
    // dangerous direction. This is the same rule Provision applies to a
    // business rule naming a missing entitlement.
    const outcome = evaluateSodRule(
      rule,
      [holding({})],
      [
        {
          systemId: 'ad',
          resourceKind: 'targetEntitlement',
          resourceId: 'ent-ap-approve',
          reason: 'missing at its target',
        },
      ],
    );
    expect(outcome.kind).toBe('unevaluable');
    if (outcome.kind !== 'unevaluable') throw new Error('unreachable');
    expect(outcome.reasons[0]).toContain('missing at its target');
  });

  it('is unevaluable even when the OTHER side is fully held', () => {
    const outcome = evaluateSodRule(
      rule,
      [holding({}), holding({ resourceId: 'ent-ap-approve' })],
      [
        {
          systemId: 'ad',
          resourceKind: 'targetEntitlement',
          resourceId: 'ent-ap-approve',
          reason: 'unreadable',
        },
      ],
    );
    expect(outcome.kind).toBe('unevaluable');
  });

  it('is clear when the rule is disabled', () => {
    expect(
      evaluateSodRule(
        { ...rule, enabled: false },
        [holding({}), holding({ resourceId: 'ent-ap-approve' })],
        [],
      ).kind,
    ).toBe('clear');
  });

  it('is UNEVALUABLE when a function names NO resources at all', () => {
    // The empty case, in the dangerous direction. A function with no resources
    // can never be held, so a naive implementation silently disables the rule
    // and the dashboard says the organization is clean.
    const outcome = evaluateSodRule(
      { ...rule, functionB: { ...approve, resources: [] } },
      [holding({})],
      [],
    );
    expect(outcome.kind).toBe('unevaluable');
    if (outcome.kind !== 'unevaluable') throw new Error('unreachable');
    expect(outcome.reasons.join(' ')).toContain('names no resources');
  });
});

describe('evaluateSodRules', () => {
  it('evaluates per person and returns only the persons with an outcome worth recording', () => {
    const result = evaluateSodRules(
      [rule],
      new Map([
        ['p-clean', [holding({})]],
        ['p-bad', [holding({}), holding({ resourceId: 'ent-ap-approve' })]],
      ]),
      [],
    );
    expect(result.get('p-bad')?.[0]?.outcome.kind).toBe('violation');
    expect(result.has('p-clean')).toBe(false);
  });
});

describe('sodImpact — the rule editor’s and Provision’s preview', () => {
  it('counts what a plan would INTRODUCE, separately from what already violates', () => {
    const impact = sodImpact({
      rules: [rule],
      holdingsByPerson: new Map([
        ['p-1', [holding({})]],
        ['p-2', [holding({}), holding({ resourceId: 'ent-ap-approve' })]],
      ]),
      wouldGrant: new Map([['p-1', [holding({ resourceId: 'ent-ap-approve' })]]]),
      unevaluable: [],
    });
    expect(impact.introduced).toHaveLength(1);
    expect(impact.introduced[0]).toMatchObject({
      personId: 'p-1',
      ruleId: 'rule-1',
      severity: 'critical',
    });
    expect(impact.introducedCritical).toBe(1);
    // p-2 already violates and is NOT counted as introduced. A preview that
    // conflated them would tell an administrator their rule creates a violation
    // that was already there, and they would learn to ignore the column.
    expect(impact.alreadyViolating).toBe(1);
  });

  it('sees a subject who holds NOTHING today and would be granted BOTH sides', () => {
    // The birthright case, and the one a rule editor most needs: one rule
    // grants both functions to a new joiner at once. They appear in no
    // holdings map because they hold nothing yet, and an implementation that
    // iterated only the holdings would report the plan as clean.
    const impact = sodImpact({
      rules: [rule],
      holdingsByPerson: new Map(),
      wouldGrant: new Map([
        ['p-new', [holding({}), holding({ resourceId: 'ent-ap-approve' })]],
      ]),
      unevaluable: [],
    });
    expect(impact.introduced).toHaveLength(1);
    expect(impact.introduced[0]).toMatchObject({ personId: 'p-new', severity: 'critical' });
    expect(impact.introducedCritical).toBe(1);
  });

  it('counts nothing as introduced when the grant changes nothing', () => {
    const impact = sodImpact({
      rules: [rule],
      holdingsByPerson: new Map([['p-1', [holding({})]]]),
      wouldGrant: new Map([['p-1', [holding({ resourceId: 'ent-ap-entry' })]]]),
      unevaluable: [],
    });
    expect(impact.introduced).toEqual([]);
  });

  it('counts subjects it could not evaluate rather than calling them clear', () => {
    const impact = sodImpact({
      rules: [rule],
      holdingsByPerson: new Map([['p-1', [holding({})]]]),
      wouldGrant: new Map([['p-1', [holding({ resourceId: 'ent-ap-approve' })]]]),
      unevaluable: [
        {
          systemId: 'ad',
          resourceKind: 'targetEntitlement',
          resourceId: 'ent-ap-approve',
          reason: 'unreadable',
        },
      ],
    });
    expect(impact.introduced).toEqual([]);
    expect(impact.unevaluableSubjects).toBe(1);
  });
});
