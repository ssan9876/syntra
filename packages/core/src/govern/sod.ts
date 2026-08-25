import { resourceKey, type ResourceKind, type Severity } from './types.js';

/**
 * Segregation of duties, evaluated over plain values.
 *
 * PURE, and deliberately so: Provision's guard and its rule editor call
 * `sodImpact()` and `evaluateSodRules()`, and Automate's eligibility check
 * calls into this module too. If any of them needed Govern to be QUERIED, the
 * seam would be wrong and it should be raised rather than worked around.
 *
 * The unit of a rule is a BUSINESS FUNCTION, not an entitlement. A rule written
 * directly over two Active Directory groups is wrong within a year and wrong
 * invisibly: a group gets renamed, a second group is created that confers the
 * same power, a second system is introduced that does payments, and the rule
 * sees nothing.
 */

export interface FunctionResource {
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
}

export interface SodFunction {
  functionId: string;
  name: string;
  resources: readonly FunctionResource[];
}

export interface SodRuleFacts {
  ruleId: string;
  name: string;
  functionA: SodFunction;
  functionB: SodFunction;
  severity: Severity;
  enabled: boolean;
}

export interface PersonHolding {
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  /** The contracts that produced this holding, for the concurrent-contract case. */
  contractIds: readonly string[];
  /**
   * THREE-VALUED, and absent means `held`.
   *
   * §8 rule 3: "no aggregation path exists that collapses `unknown` into
   * `not_held`." `loadSodFacts` used to read `state: 'held'` only, so a person
   * whose payments entitlement sat behind an unreadable region evaluated as
   * CLEAR on a critical rule -- the false-assurance defect this module exists
   * to avoid, in the one place where the output is somebody signing that duties
   * are separated.
   *
   * Optional because Provision's `sodImpact` builds `wouldGrant` holdings by
   * hand and has no state to give: what a rule WOULD grant is held by
   * construction.
   */
  state?: 'held' | 'unknown' | undefined;
}

export interface UnevaluableResource {
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  reason: string;
}

export type SodOutcome =
  | { kind: 'clear' }
  | {
      kind: 'violation';
      holdingsA: PersonHolding[];
      holdingsB: PersonHolding[];
      contractsA: string[];
      contractsB: string[];
    }
  | { kind: 'unevaluable'; reasons: string[] };

const keyOf = (r: FunctionResource | PersonHolding) =>
  resourceKey({
    systemKind: 'targetSystem',
    systemId: r.systemId,
    resourceKind: r.resourceKind,
    resourceId: r.resourceId,
  });

export function evaluateSodRule(
  rule: SodRuleFacts,
  holdings: readonly PersonHolding[],
  unevaluable: readonly UnevaluableResource[],
): SodOutcome {
  if (!rule.enabled) return { kind: 'clear' };

  // A function with NO resources can never be held, so a naive implementation
  // silently disables the rule and the dashboard says the organization is
  // clean. The empty pattern is the universal pattern unless something says
  // otherwise, and here saying otherwise means refusing to evaluate.
  const reasons: string[] = [];
  for (const fn of [rule.functionA, rule.functionB]) {
    if (fn.resources.length === 0) {
      reasons.push(
        `the business function "${fn.name}" names no resources, so this rule cannot be evaluated`,
      );
    }
  }

  const unevaluableKeys = new Map(unevaluable.map((u) => [keyOf(u), u.reason]));
  for (const fn of [rule.functionA, rule.functionB]) {
    for (const resource of fn.resources) {
      const reason = unevaluableKeys.get(keyOf(resource));
      if (reason !== undefined) {
        reasons.push(`a resource of the business function "${fn.name}" cannot be read: ${reason}`);
      }
    }
  }
  // A RULE WHOSE TWO FUNCTIONS NAME THE SAME RESOURCE CANNOT SEPARATE THEM.
  //
  // The rule says "these two duties must not be held by one person". If one
  // resource is in both functions, a person holding only that resource
  // satisfies both sides and is reported in violation of a rule they cannot
  // possibly breach -- and a rule with real overlap fires against every holder
  // of the shared resource, which on a `critical` rule is the whole department
  // and a board nobody reads by the second morning.
  //
  // Refused, not silently narrowed. Excluding the shared resource would leave a
  // rule that means something different from what its author wrote, and the
  // author is the only person who can say which side it belongs on.
  const bResourceKeys = rule.functionB.resources.map(keyOf);
  const sharedKeys = rule.functionA.resources
    .map(keyOf)
    .filter((key) => bResourceKeys.includes(key));
  for (const key of sharedKeys) {
    reasons.push(
      `the resource ${key} is named by BOTH "${rule.functionA.name}" and ` +
        `"${rule.functionB.name}", so this rule cannot say the two duties are separated`,
    );
  }

  const aKeys = new Set(rule.functionA.resources.map(keyOf));
  const bKeys = new Set(rule.functionB.resources.map(keyOf));

  const holdingsA = holdings.filter((h) => aKeys.has(keyOf(h)));
  const holdingsB = holdings.filter((h) => bKeys.has(keyOf(h)));

  // An UNKNOWN holding on either side makes the answer unknown, never clear.
  // The person genuinely may hold both; nobody read the region that would say.
  for (const holding of [...holdingsA, ...holdingsB]) {
    if (holding.state === 'unknown') {
      reasons.push(
        `"${holding.resourceName}" is held-or-not-held as far as anybody knows: ` +
          'the region that would say has not been read, so this rule cannot be evaluated for this person',
      );
    }
  }

  if (reasons.length > 0) {
    // UNEVALUABLE only for somebody with exposure. A person who holds nothing
    // on either readable side cannot be shown to violate this rule by anything
    // observed, and the unreadable region is already a coverage gap in its own
    // right — so reporting them would put a row on the board for every person
    // in the tenant the moment one target goes unread. At 40,000 people that is
    // 40,000 rows saying nothing, and a board nobody reads is the failure this
    // module exists to avoid.
    //
    // Anybody holding EITHER side is reported, because for them the answer
    // genuinely turns on the part that could not be read.
    if (holdingsA.length === 0 && holdingsB.length === 0) return { kind: 'clear' };
    return { kind: 'unevaluable', reasons };
  }

  if (holdingsA.length === 0 || holdingsB.length === 0) return { kind: 'clear' };

  return {
    kind: 'violation',
    holdingsA,
    holdingsB,
    contractsA: [...new Set(holdingsA.flatMap((h) => [...h.contractIds]))],
    contractsB: [...new Set(holdingsB.flatMap((h) => [...h.contractIds]))],
  };
}

export function evaluateSodRules(
  rules: readonly SodRuleFacts[],
  holdingsByPerson: ReadonlyMap<string, readonly PersonHolding[]>,
  unevaluable: readonly UnevaluableResource[],
): Map<string, { ruleId: string; outcome: SodOutcome }[]> {
  const out = new Map<string, { ruleId: string; outcome: SodOutcome }[]>();
  for (const [personId, holdings] of holdingsByPerson) {
    const results = rules
      .map((rule) => ({
        ruleId: rule.ruleId,
        outcome: evaluateSodRule(rule, holdings, unevaluable),
      }))
      .filter((r) => r.outcome.kind !== 'clear');
    if (results.length > 0) out.set(personId, results);
  }
  return out;
}

export interface SodImpactInput {
  rules: readonly SodRuleFacts[];
  holdingsByPerson: ReadonlyMap<string, readonly PersonHolding[]>;
  /** What a plan or a rule would ADD. */
  wouldGrant: ReadonlyMap<string, readonly PersonHolding[]>;
  unevaluable: readonly UnevaluableResource[];
}

export interface SodImpact {
  introduced: { personId: string; ruleId: string; ruleName: string; severity: Severity }[];
  introducedCritical: number;
  alreadyViolating: number;
  unevaluableSubjects: number;
}

/**
 * What a change would INTRODUCE, counted separately from what already violates.
 *
 * Conflating them would tell an administrator their rule creates a violation
 * that was already there, and they would learn to ignore the column — which is
 * worse than not having it, because prevention at the point where the fault
 * actually is is the highest-value integration this module offers.
 */
export function sodImpact(input: SodImpactInput): SodImpact {
  const introduced: SodImpact['introduced'] = [];
  const unevaluableSubjects = new Set<string>();
  let alreadyViolating = 0;

  // The UNION of both maps, not `holdingsByPerson` alone. A birthright rule
  // that grants BOTH sides at once introduces a violation in somebody who
  // holds nothing today, and iterating only over people who already hold
  // something would report that plan as clean — which is the single case a
  // rule editor's preview most needs to catch, because it is the one an
  // administrator creates with one click.
  const subjects = new Set([...input.holdingsByPerson.keys(), ...input.wouldGrant.keys()]);

  for (const personId of subjects) {
    const holdings = input.holdingsByPerson.get(personId) ?? [];
    const added = input.wouldGrant.get(personId) ?? [];
    const after = [...holdings, ...added];

    for (const rule of input.rules) {
      const before = evaluateSodRule(rule, holdings, input.unevaluable);
      const afterOutcome = evaluateSodRule(rule, after, input.unevaluable);

      if (before.kind === 'unevaluable' || afterOutcome.kind === 'unevaluable') {
        unevaluableSubjects.add(personId);
        continue;
      }
      if (before.kind === 'violation') {
        alreadyViolating += 1;
        continue;
      }
      if (afterOutcome.kind === 'violation') {
        introduced.push({
          personId,
          ruleId: rule.ruleId,
          ruleName: rule.name,
          severity: rule.severity,
        });
      }
    }
  }

  return {
    introduced,
    introducedCritical: introduced.filter((i) => i.severity === 'critical').length,
    alreadyViolating,
    unevaluableSubjects: unevaluableSubjects.size,
  };
}
