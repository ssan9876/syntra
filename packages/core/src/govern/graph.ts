import type { Severity } from './types.js';

/**
 * The decision graph Automate's section 9 named as Govern's problem.
 *
 * Automate closes every path to self-approval it can see and names the tenth
 * honestly: two-stage laundering — the subject decides stage 1 of somebody
 * else's request, who decides stage 2 of theirs. It does not attempt to detect
 * that, it says it needs a graph over decisions across requests and time, and
 * it says what it owes Govern: every decision, with the deciding person, the
 * subject, the submitter, the selector that resolved them, whether they acted
 * as a delegate or an escalation target, and the time.
 *
 * THE HANDOFF WORKS. Three qualifications close real holes rather than quibbles,
 * and each is closed by looking somewhere else in Automate's own data.
 *
 * PURE.
 */

export type EdgeKind = 'decided_for' | 'delegated_grant' | 'auto_granted';

export interface DecisionEdge {
  kind: EdgeKind;
  /** Null for `auto_granted`: a zero-stage workflow has no decider at all. */
  fromPersonId: string | null;
  toPersonId: string;
  requestId: string;
  decidedAt: Date;
  via: string;
  selector: string | null;
}

export interface UnmergeableActor {
  userId: string;
  requestIds: string[];
}

/** A tree deep enough to hit this is noise, not a finding somebody can read. */
export const MAX_GRAPH_DEPTH = 6;

export interface GraphInput {
  edges: readonly DecisionEdge[];
  unmergeable: readonly UnmergeableActor[];
  sodPairs: readonly {
    ruleId: string;
    ruleName: string;
    severity: Severity;
    /**
     * FULL RESOURCE KEYS -- `${systemId}|${resourceKind}|${resourceId}` -- not
     * bare ids. Every id in this platform is the target's OWN object
     * identifier, unique within a target and meaningless across them, so
     * matching on the id alone made `e1` in the finance target and `e1` in the
     * HR target the same resource. On a tenant with two connectors that is not
     * a corner case, and the finding it produces names two people and a
     * critical rule.
     */
    sideAResourceKeys: readonly string[];
    sideBResourceKeys: readonly string[];
  }[];
  grantedResourceKeyByRequest: ReadonlyMap<string, string>;
  minReciprocalDecisions: number;
  reciprocityWindowDays: number;
  now: Date;
}

export interface GraphReport {
  reciprocity: { a: string; b: string; aToB: number; bToA: number; requestIds: string[] }[];
  cycles: { path: string[]; requestIds: string[] }[];
  laundering: {
    ruleId: string; ruleName: string; severity: Severity;
    a: string; b: string; requestIds: string[];
  }[];
  autoGranted: { toPersonId: string; requestIds: string[] }[];
  unmergeableActors: UnmergeableActor[];
}

export function buildDecisionGraph(input: GraphInput): GraphReport {
  const cutoff = new Date(input.now.getTime() - input.reciprocityWindowDays * 86_400_000);
  const inWindow = input.edges.filter((e) => e.decidedAt >= cutoff);

  // `auto_granted` contributes NO edge: nobody decided, so it can neither
  // reciprocate nor complete a cycle. It is counted and listed as its own class,
  // and campaigned first — access nobody decided is precisely the access a
  // recertification exists to have somebody decide.
  const autoByPerson = new Map<string, string[]>();
  for (const e of inWindow) {
    if (e.kind !== 'auto_granted') continue;
    autoByPerson.set(e.toPersonId, [...(autoByPerson.get(e.toPersonId) ?? []), e.requestId]);
  }

  const directed = inWindow.filter((e) => e.kind !== 'auto_granted' && e.fromPersonId !== null);

  // ---- reciprocity --------------------------------------------------------
  const pairCounts = new Map<string, { requestIds: string[] }>();
  for (const e of directed) {
    const key = `${e.fromPersonId}>${e.toPersonId}`;
    pairCounts.set(key, { requestIds: [...(pairCounts.get(key)?.requestIds ?? []), e.requestId] });
  }

  const reciprocity: GraphReport['reciprocity'] = [];
  const seenPairs = new Set<string>();
  for (const [key, forward] of pairCounts) {
    const [a, b] = key.split('>') as [string, string];
    const unordered = [a, b].sort().join('|');
    if (seenPairs.has(unordered)) continue;
    const back = pairCounts.get(`${b}>${a}`);
    if (back === undefined) continue;
    // The minimum in BOTH directions, not the sum: a manager who decided
    // fifteen of their report's requests and had one decided back is a manager,
    // not a pattern.
    if (
      forward.requestIds.length < input.minReciprocalDecisions ||
      back.requestIds.length < input.minReciprocalDecisions
    ) {
      continue;
    }
    seenPairs.add(unordered);
    reciprocity.push({
      a, b,
      aToB: forward.requestIds.length,
      bToA: back.requestIds.length,
      requestIds: [...forward.requestIds, ...back.requestIds],
    });
  }

  // ---- cycles -------------------------------------------------------------
  const outgoing = new Map<string, DecisionEdge[]>();
  for (const e of directed) {
    outgoing.set(e.fromPersonId!, [...(outgoing.get(e.fromPersonId!) ?? []), e]);
  }

  const cycles: GraphReport['cycles'] = [];
  const reportedCycles = new Set<string>();
  const walk = (start: string, node: string, path: string[], requestIds: string[]): void => {
    if (path.length > MAX_GRAPH_DEPTH) return;
    for (const e of outgoing.get(node) ?? []) {
      // THREE, not two. A two-node cycle is a reciprocal PAIR, and the pair
      // axis above already reports it — with a MINIMUM behind it. Closing at
      // two puts the same pair in two findings with two counts, and worse, it
      // routes around `minReciprocalDecisions` entirely: a manager who approved
      // one request for their report and had one approved back is a two-cycle,
      // so every reciprocal pair in the tenant becomes a finding by the other
      // door and the minimum is advisory. The cycle axis exists for what a
      // pairwise check MISSES.
      if (e.toPersonId === start && path.length >= 3) {
        const canonical = [...path].sort().join('|');
        if (!reportedCycles.has(canonical)) {
          reportedCycles.add(canonical);
          cycles.push({ path: [...path], requestIds: [...requestIds, e.requestId] });
        }
        continue;
      }
      if (path.includes(e.toPersonId)) continue;
      walk(start, e.toPersonId, [...path, e.toPersonId], [...requestIds, e.requestId]);
    }
  };
  for (const start of outgoing.keys()) walk(start, start, [start], []);

  // ---- SoD laundering -----------------------------------------------------
  // The pattern that is actually a finding rather than a signal, and it is
  // detectable ONLY with the SoD rules in hand.
  //
  // INDEXED BY PAIR, ONCE. The previous shape was
  // `for rule { for forward { for back { ... } } }` with the pair filter INSIDE
  // the inner loop, so it walked every edge against every other edge for every
  // rule: 10,000 decisions and 20 rules is about 2 x 10^9 iterations,
  // synchronous, on the nightly job's event loop, starving every other job --
  // and it cost that whether or not any laundering existed. The rules do not
  // change the pairs, so the pairs are built first and each is tested against
  // each rule: O(E + P x R) instead of O(E^2 x R).
  const byPair = new Map<string, DecisionEdge[]>();
  for (const e of directed) {
    const key = `${e.fromPersonId}>${e.toPersonId}`;
    byPair.set(key, [...(byPair.get(key) ?? []), e]);
  }

  const laundering: GraphReport['laundering'] = [];
  const seenLaundering = new Set<string>();
  for (const [key, forwards] of byPair) {
    const [a, b] = key.split('>') as [string, string];
    const backs = byPair.get(`${b}>${a}`);
    if (backs === undefined) continue;

    for (const rule of input.sodPairs) {
      const unordered = `${rule.ruleId}|${[a, b].sort().join('|')}`;
      if (seenLaundering.has(unordered)) continue;
      const sideA = new Set(rule.sideAResourceKeys);
      const sideB = new Set(rule.sideBResourceKeys);

      let found: { forward: DecisionEdge; back: DecisionEdge } | null = null;
      for (const forward of forwards) {
        const forwardResource = input.grantedResourceKeyByRequest.get(forward.requestId);
        if (forwardResource === undefined) continue;
        for (const back of backs) {
          const backResource = input.grantedResourceKeyByRequest.get(back.requestId);
          if (backResource === undefined) continue;
          const opposite =
            (sideA.has(forwardResource) && sideB.has(backResource)) ||
            (sideB.has(forwardResource) && sideA.has(backResource));
          if (!opposite) continue;
          found = { forward, back };
          break;
        }
        if (found !== null) break;
      }
      if (found === null) continue;

      seenLaundering.add(unordered);
      laundering.push({
        ruleId: rule.ruleId,
        ruleName: rule.ruleName,
        severity: rule.severity,
        a,
        b,
        requestIds: [found.forward.requestId, found.back.requestId],
      });
    }
  }

  return {
    reciprocity,
    cycles,
    laundering,
    autoGranted: [...autoByPerson].map(([toPersonId, requestIds]) => ({ toPersonId, requestIds })),
    // Reported separately rather than dropped.
    unmergeableActors: [...input.unmergeable],
  };
}
