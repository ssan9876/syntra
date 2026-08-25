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

/**
 * TWO FUNCTIONS THAT NAME THE SAME RESOURCE.
 *
 * The rule is "these two duties must not be held by one person". If one
 * resource is in both functions, then a person holding ONLY that resource
 * satisfies both sides and is reported in violation of a rule they cannot
 * possibly breach -- and worse, a rule with real overlap fires against every
 * holder of the shared resource, which on a `critical` rule is the whole
 * department.
 *
 * Refused rather than silently narrowed: a rule whose two functions overlap
 * cannot say the duties are separated, and quietly excluding the shared
 * resource would leave a rule that means something different from what its
 * author wrote.
 */
describe('a rule whose two functions share a resource', () => {
  const shared = { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'e1' };
  const rule: SodRuleFacts = {
    ruleId: 'r1',
    name: 'Raise and approve',
    functionA: { functionId: 'fa', name: 'Raise', resources: [shared] },
    functionB: { functionId: 'fb', name: 'Approve', resources: [shared] },
    severity: 'critical',
    enabled: true,
  };

  it('is UNEVALUABLE rather than a violation for somebody holding it once', () => {
    const outcome = evaluateSodRule(
      rule,
      [{ ...shared, resourceName: 'Payments', contractIds: [] }],
      [],
    );
    expect(outcome.kind).toBe('unevaluable');
    if (outcome.kind !== 'unevaluable') return;
    expect(outcome.reasons.join(' ')).toContain('e1');
    expect(outcome.reasons.join(' ')).toMatch(/both/i);
  });

  it('says nothing at all about somebody who holds neither side', () => {
    // The same rule §14's unevaluable branch already follows: a person with no
    // exposure must not put a row on the board, or one misconfigured rule is
    // 40,000 rows saying nothing.
    expect(evaluateSodRule(rule, [], []).kind).toBe('clear');
  });
});

/**
 * §8 rule 3: "No aggregation path exists that collapses `unknown` into
 * `not_held`." `loadSodFacts` read `state: 'held'` only, so a person whose
 * payments entitlement sits behind an unreadable region evaluated as CLEAR on
 * a critical rule -- the false-assurance defect this module exists to avoid, in
 * the one place where the output is somebody signing that duties are separated.
 */
describe('a holding whose state is unknown', () => {
  const raise = { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'e1' };
  const approve = { systemId: 'ad', resourceKind: 'targetEntitlement' as const, resourceId: 'e2' };
  const rule: SodRuleFacts = {
    ruleId: 'r1',
    name: 'Raise and approve',
    functionA: { functionId: 'fa', name: 'Raise', resources: [raise] },
    functionB: { functionId: 'fb', name: 'Approve', resources: [approve] },
    severity: 'critical',
    enabled: true,
  };

  it('is UNEVALUABLE, never clear, when one side is unknown', () => {
    const outcome = evaluateSodRule(
      rule,
      [
        { ...raise, resourceName: 'Raise payment', contractIds: [], state: 'held' },
        { ...approve, resourceName: 'Approve payment', contractIds: [], state: 'unknown' },
      ],
      [],
    );
    expect(outcome.kind).toBe('unevaluable');
    if (outcome.kind !== 'unevaluable') return;
    expect(outcome.reasons.join(' ')).toContain('Approve');
  });

  it('still reports a violation when BOTH sides are known held', () => {
    const outcome = evaluateSodRule(
      rule,
      [
        { ...raise, resourceName: 'Raise payment', contractIds: [], state: 'held' },
        { ...approve, resourceName: 'Approve payment', contractIds: [], state: 'held' },
      ],
      [],
    );
    expect(outcome.kind).toBe('violation');
  });

  it('treats an absent state as held, for the callers that never set one', () => {
    // Provision's `sodImpact` builds `wouldGrant` holdings by hand and has no
    // state to give: what a rule WOULD grant is held by construction.
    const outcome = evaluateSodRule(
      rule,
      [
        { ...raise, resourceName: 'Raise payment', contractIds: [] },
        { ...approve, resourceName: 'Approve payment', contractIds: [] },
      ],
      [],
    );
    expect(outcome.kind).toBe('violation');
  });
});
