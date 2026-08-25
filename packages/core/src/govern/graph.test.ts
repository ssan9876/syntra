import { describe, expect, it } from 'vitest';
import { MAX_GRAPH_DEPTH, buildDecisionGraph, type DecisionEdge, type GraphInput } from './graph.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const edge = (over: Partial<DecisionEdge>): DecisionEdge => ({
  kind: 'decided_for',
  fromPersonId: 'a',
  toPersonId: 'b',
  requestId: 'r-1',
  decidedAt: daysAgo(1),
  via: 'selector',
  selector: 'manager',
  ...over,
});

const input = (over: Partial<GraphInput> = {}): GraphInput => ({
  edges: [],
  unmergeable: [],
  sodPairs: [],
  grantedResourceKeyByRequest: new Map(),
  minReciprocalDecisions: 3,
  reciprocityWindowDays: 180,
  now: NOW,
  ...over,
});

describe('reciprocity', () => {
  it('reports a pair who each decided for the other at least the minimum times', () => {
    const edges = [
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}` })),
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'b', toPersonId: 'a', requestId: `ba-${i}` })),
    ];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.reciprocity).toHaveLength(1);
    expect(report.reciprocity[0]).toMatchObject({ aToB: 3, bToA: 3 });
    expect(report.reciprocity[0]!.requestIds).toHaveLength(6);
  });

  it('reports nothing below the minimum', () => {
    const edges = [
      ...[1, 2].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}` })),
      ...[1, 2].map((i) => edge({ fromPersonId: 'b', toPersonId: 'a', requestId: `ba-${i}` })),
    ];
    expect(buildDecisionGraph(input({ edges })).reciprocity).toEqual([]);
  });

  it('ignores decisions outside the window', () => {
    const edges = [
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}`, decidedAt: daysAgo(400) })),
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'b', toPersonId: 'a', requestId: `ba-${i}` })),
    ];
    expect(buildDecisionGraph(input({ edges })).reciprocity).toEqual([]);
  });

  it('needs the minimum in BOTH directions, not the sum', () => {
    const edges = [
      ...[1, 2, 3, 4, 5].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}` })),
      edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'ba-1' }),
    ];
    expect(buildDecisionGraph(input({ edges })).reciprocity).toEqual([]);
  });
});

describe('cycles', () => {
  it('reports A→B→C→A, which a pairwise check misses', () => {
    const edges = [
      edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-ab' }),
      edge({ fromPersonId: 'b', toPersonId: 'c', requestId: 'r-bc' }),
      edge({ fromPersonId: 'c', toPersonId: 'a', requestId: 'r-ca' }),
    ];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.cycles).toHaveLength(1);
    expect(report.cycles[0]!.path).toEqual(['a', 'b', 'c']);
  });

  it('does NOT report a reciprocal PAIR as a two-node cycle', () => {
    // The pair axis has a minimum; the cycle axis has none. Closing a cycle at
    // two nodes routes around `minReciprocalDecisions` completely — one
    // approval each way, which is what a manager and their report do, would be
    // a finding. And where the pair IS over the minimum it would be two
    // findings and two counts behind one thing.
    const edges = [
      edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-ab' }),
      edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r-ba' }),
    ];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.cycles).toEqual([]);
    expect(report.reciprocity).toEqual([]);
  });

  it('still reports the pair once when it is over the minimum, and only once', () => {
    const edges = [
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'a', toPersonId: 'b', requestId: `ab-${i}` })),
      ...[1, 2, 3].map((i) => edge({ fromPersonId: 'b', toPersonId: 'a', requestId: `ba-${i}` })),
    ];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.reciprocity).toHaveLength(1);
    expect(report.cycles).toEqual([]);
  });

  it('terminates at the depth cap rather than exploring a dense graph forever', () => {
    const edges: DecisionEdge[] = [];
    for (let i = 0; i < 20; i += 1) {
      edges.push(edge({ fromPersonId: `p${i}`, toPersonId: `p${(i + 1) % 20}`, requestId: `r-${i}` }));
    }
    const report = buildDecisionGraph(input({ edges }));
    // The 20-cycle is longer than the cap and is deliberately NOT reported.
    // A finding nobody can read is worse than no finding.
    expect(report.cycles.every((c) => c.path.length <= MAX_GRAPH_DEPTH)).toBe(true);
  });
});

describe('the three qualifications Automate’s handoff left open', () => {
  it('QUALIFICATION ONE: a delegated grant produces an edge with no ApprovalDecision behind it', () => {
    // A graph built only from ApprovalDecision cannot see a pair of team leads
    // who each granted the other access to the resource they manage — the same
    // laundering pattern with LESS friction than the two-stage one, since it
    // needs no requests at all.
    const edges = [
      ...[1, 2, 3].map((i) =>
        edge({ kind: 'delegated_grant', fromPersonId: 'a', toPersonId: 'b', requestId: `d-ab-${i}` }),
      ),
      ...[1, 2, 3].map((i) =>
        edge({ kind: 'delegated_grant', fromPersonId: 'b', toPersonId: 'a', requestId: `d-ba-${i}` }),
      ),
    ];
    expect(buildDecisionGraph(input({ edges })).reciprocity).toHaveLength(1);
  });

  it('QUALIFICATION TWO: an auto-granted request is its own class with no decider', () => {
    const edges = [edge({ kind: 'auto_granted', fromPersonId: null, toPersonId: 'b', requestId: 'r-auto' })];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.autoGranted).toEqual([{ toPersonId: 'b', requestIds: ['r-auto'] }]);
    // It contributes no edge to reciprocity or cycles, because nobody decided.
    expect(report.reciprocity).toEqual([]);
    expect(report.cycles).toEqual([]);
  });

  it('counts NOBODY as the decider of an auto-granted request, even with a person on the row', () => {
    // The kind is what decides this, not the null. `fromPersonId: null` is the
    // contract, but it is a type annotation and nothing enforces it — a caller
    // that filled the field with the SUBMITTER (which is the obvious thing to
    // reach for, since somebody did press the button) would turn a zero-stage
    // product into a stream of decisions nobody made, with a person's name on
    // every one. The previous version of this case passed `fromPersonId: null`,
    // so deleting the kind check from the directed filter changed nothing.
    const edges = [
      ...[1, 2, 3].map((i) =>
        edge({ kind: 'auto_granted', fromPersonId: 'a', toPersonId: 'b', requestId: `auto-ab-${i}` }),
      ),
      ...[1, 2, 3].map((i) =>
        edge({ kind: 'auto_granted', fromPersonId: 'b', toPersonId: 'a', requestId: `auto-ba-${i}` }),
      ),
    ];
    const report = buildDecisionGraph(input({ edges }));
    expect(report.reciprocity).toEqual([]);
    expect(report.cycles).toEqual([]);
    expect(report.autoGranted).toHaveLength(2);
  });

  it('QUALIFICATION THREE: an actor with no linked person is REPORTED, never dropped', () => {
    // A service account submitting requests on people's behalf is either an
    // integration worth knowing about or a problem worth knowing about, and
    // either way silence is the wrong answer.
    const report = buildDecisionGraph(
      input({ unmergeable: [{ userId: 'svc-1', requestIds: ['r-1', 'r-2'] }] }),
    );
    expect(report.unmergeableActors).toEqual([{ userId: 'svc-1', requestIds: ['r-1', 'r-2'] }]);
  });
});

describe('SoD laundering — the one that is a finding rather than a signal', () => {
  it('reports A deciding B onto side A while B decided A onto side B of the same rule', () => {
    const report = buildDecisionGraph(
      input({
        edges: [
          edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-1' }),
          edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r-2' }),
        ],
        grantedResourceKeyByRequest: new Map([
          ['r-1', 'ent-raise'],
          ['r-2', 'ent-approve'],
        ]),
        sodPairs: [
          {
            ruleId: 'rule-1', ruleName: 'Payment raising and approval', severity: 'critical',
            sideAResourceKeys: ['ent-raise'], sideBResourceKeys: ['ent-approve'],
          },
        ],
      }),
    );
    expect(report.laundering).toHaveLength(1);
    expect(report.laundering[0]).toMatchObject({ ruleId: 'rule-1', severity: 'critical' });
  });

  it('reports nothing when both grants are on the SAME side', () => {
    const report = buildDecisionGraph(
      input({
        edges: [
          edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-1' }),
          edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r-2' }),
        ],
        grantedResourceKeyByRequest: new Map([['r-1', 'ent-raise'], ['r-2', 'ent-raise']]),
        sodPairs: [
          {
            ruleId: 'rule-1', ruleName: 'x', severity: 'critical',
            sideAResourceKeys: ['ent-raise'], sideBResourceKeys: ['ent-approve'],
          },
        ],
      }),
    );
    expect(report.laundering).toEqual([]);
  });

  it('reports nothing at all with NO SoD rules in hand', () => {
    // Detectable ONLY with the rules, which is why this lands in slice 2
    // alongside them rather than in the inventory.
    const report = buildDecisionGraph(
      input({
        edges: [
          edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r-1' }),
          edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r-2' }),
        ],
        grantedResourceKeyByRequest: new Map([['r-1', 'ent-raise'], ['r-2', 'ent-approve']]),
      }),
    );
    expect(report.laundering).toEqual([]);
  });
});

describe('the empty graph', () => {
  it('reports nothing rather than everything', () => {
    expect(buildDecisionGraph(input())).toEqual({
      reciprocity: [], cycles: [], laundering: [], autoGranted: [], unmergeableActors: [],
    });
  });
});

/**
 * TWO RESOURCES SHARING AN ID IN DIFFERENT SYSTEMS.
 *
 * The laundering scan matched on `resourceId` alone, so `e1` in the finance
 * target and `e1` in the HR target were the same resource. Every id in this
 * platform is the target's OWN object identifier, which is unique within a
 * target and says nothing across them -- so on a tenant with two connectors
 * this is not a corner case, it is Tuesday. The finding it produces names two
 * people and a critical rule.
 */
describe('laundering matches on the FULL resource key', () => {
  it('does not match two resources that share an id in different systems', () => {
    const report = buildDecisionGraph(
      input({
        edges: [
          edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r1' }),
          edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r2' }),
        ],
        sodPairs: [
          {
            ruleId: 'rule-1',
            ruleName: 'Raise and approve',
            severity: 'critical',
            sideAResourceKeys: ['finance|targetEntitlement|e1'],
            sideBResourceKeys: ['hr|targetEntitlement|e1'],
          },
        ],
        grantedResourceKeyByRequest: new Map([
          ['r1', 'finance|targetEntitlement|e1'],
          // The SAME id, a different system. Under the old bare-id key this
          // matched side B and produced a critical finding about two people.
          ['r2', 'finance|targetEntitlement|e1'],
        ]),
        minReciprocalDecisions: 1,
      }),
    );
    expect(report.laundering).toEqual([]);
  });

  it('still finds the pattern when the two sides really are opposite', () => {
    const report = buildDecisionGraph(
      input({
        edges: [
          edge({ fromPersonId: 'a', toPersonId: 'b', requestId: 'r1' }),
          edge({ fromPersonId: 'b', toPersonId: 'a', requestId: 'r2' }),
        ],
        sodPairs: [
          {
            ruleId: 'rule-1',
            ruleName: 'Raise and approve',
            severity: 'critical',
            sideAResourceKeys: ['finance|targetEntitlement|e1'],
            sideBResourceKeys: ['finance|targetEntitlement|e2'],
          },
        ],
        grantedResourceKeyByRequest: new Map([
          ['r1', 'finance|targetEntitlement|e1'],
          ['r2', 'finance|targetEntitlement|e2'],
        ]),
        minReciprocalDecisions: 1,
      }),
    );
    expect(report.laundering).toHaveLength(1);
    expect(report.laundering[0]).toMatchObject({ ruleId: 'rule-1', a: 'a', b: 'b' });
  });

  /**
   * THE COST, executed rather than asserted about -- and measured as a DELTA,
   * which is the only honest way to measure it here.
   *
   * The scan was `for rule { for forward { for back { ... } } }` with the pair
   * filter INSIDE the inner loop, so its cost was O(E^2 x R): 10,000 decisions
   * and 20 rules is about 2 x 10^9 iterations, synchronous, on the nightly
   * job's event loop, whether or not any laundering existed. Indexing by pair
   * makes it O(E + P x R).
   *
   * An absolute budget on `buildDecisionGraph` would NOT test that. Measured
   * here at 4,000 edges over 400 people: 24,730 ms with ZERO rules and
   * 25,547 ms with twenty. The 24.7 s is cycle detection, which is a separate
   * unbounded cost this task does not touch and which is recorded as G29 in the
   * findings register. Laundering is the 0.8 s difference.
   *
   * So this measures RULES AGAINST NO RULES over the identical graph. Under the
   * old shape that difference was the dominant term; under this one it is
   * nearly free, and a regression to the nested scan fails here whatever the
   * rest of the function costs.
   */
  it('costs almost nothing per rule, which is what indexing by pair bought', () => {
    const edges = Array.from({ length: 4_000 }, (_unused, i) =>
      edge({
        fromPersonId: `p${i % 400}`,
        toPersonId: `p${(i + 1) % 400}`,
        requestId: `r${i}`,
      }),
    );
    const sodPairs = Array.from({ length: 20 }, (_unused, i) => ({
      ruleId: `rule-${i}`,
      ruleName: `Rule ${i}`,
      severity: 'high' as const,
      sideAResourceKeys: [`sys|targetEntitlement|a${i}`],
      sideBResourceKeys: [`sys|targetEntitlement|b${i}`],
    }));

    const grantedResourceKeyByRequest = new Map(
      edges.map((e, i) => [e.requestId, `sys|targetEntitlement|a${i % 20}`]),
    );

    const withoutRules = performance.now();
    buildDecisionGraph(
      input({ edges, sodPairs: [], grantedResourceKeyByRequest, minReciprocalDecisions: 1 }),
    );
    const baseline = performance.now() - withoutRules;

    const withRules = performance.now();
    buildDecisionGraph(
      input({ edges, sodPairs, grantedResourceKeyByRequest, minReciprocalDecisions: 1 }),
    );
    const withTwenty = performance.now() - withRules;

    // Twenty rules must not cost the graph a second on top of what it already
    // costs. Measured at ~800 ms; 5,000 ms leaves room for a loaded machine
    // while still being far under the O(E^2 x R) shape, which took minutes.
    expect(withTwenty - baseline).toBeLessThan(5_000);
  }, 300_000);
});
