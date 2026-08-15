import { evaluateIpRanges, type ConditionResult } from './ip-match.js';
import { evaluateTimeWindow } from './time-window.js';
import type {
  AuthContext,
  ContractFacts,
  PolicyDecision,
  PolicyFallback,
  PolicyRule,
} from './types.js';

const norm = (value: string) => value.trim().toLowerCase();

/**
 * A contract condition matches if ANY of the person's currently active
 * contracts satisfies it. A person with two concurrent engagements is in
 * Finance if either of them is; a person whose Finance contract ended last
 * month is not.
 *
 * A null field never matches: "department is Finance" is a claim about a
 * department, and a contract with no department recorded does not make it.
 */
function matchesContracts(rule: PolicyRule, contracts: ContractFacts[]): boolean {
  if (!rule.contractField || rule.contractValues.length === 0) return true;

  const wanted = new Set(rule.contractValues.map(norm));
  return contracts.some((contract) => {
    const value = contract[rule.contractField!];
    return value !== null && wanted.has(norm(value));
  });
}

function matchesApplication(rule: PolicyRule, applicationId: string | null): boolean {
  if (rule.applicationIds.length === 0) return true;
  if (applicationId === null) return false;
  return rule.applicationIds.includes(applicationId);
}

function matchesGroups(rule: PolicyRule, groupIds: string[]): boolean {
  if (rule.groupIds.length === 0) return true;
  return rule.groupIds.some((id) => groupIds.includes(id));
}

/**
 * Whether one rule's conditions all hold for this context.
 *
 * Exported because the administration console asks the same question of a rule
 * that has not been saved yet, to count who it would affect before it is
 * stored. That preview and the live decision must agree, so they share this
 * function rather than each carrying their own reading of the conditions.
 *
 * THE ASYMMETRY, WHICH IS DELIBERATE. Two of the five conditions can be
 * undecidable rather than simply false: a source-address condition with no
 * address to test or a malformed range, and a time window in a timezone the
 * platform cannot resolve. An undecidable condition resolves to *false* on
 * `allow`, `require_mfa` and `require_factor`, and to *true* on `deny`.
 *
 * It looks like an inconsistency and it is not. Resolving to false everywhere
 * means a rule written to refuse people quietly stops refusing them the moment
 * one of its own fields is broken — a typo in a CIDR turns "block this range"
 * into "block nobody", and nothing anywhere reports it. Resolving to true
 * everywhere would be worse in the other direction: a broken `allow` rule
 * would start letting people past conditions it was supposed to enforce. Each
 * outcome fails towards refusing, which is the only direction that is safe in
 * both cases.
 *
 * Write-time validation in policy-service.ts is what keeps this from arising;
 * this is the backstop for a row that predates the check or arrives some other
 * way.
 */
export function ruleMatches(rule: PolicyRule, context: AuthContext): boolean {
  const failClosed = rule.outcome === 'deny';
  const decided = (result: ConditionResult): boolean =>
    result === 'match' || (result === 'unevaluable' && failClosed);

  return (
    matchesApplication(rule, context.applicationId) &&
    matchesGroups(rule, context.groupIds) &&
    matchesContracts(rule, context.contracts) &&
    decided(evaluateIpRanges(context.sourceIp, rule.ipRanges)) &&
    decided(evaluateTimeWindow(rule, context.now))
  );
}

/**
 * The authentication policy engine.
 *
 * A pure function of the rule set, the fallback and the request context: no
 * database, no ambient clock, no configuration. That is what makes the whole
 * matrix testable without a server, and it is why `now` is a field on the
 * context rather than a call to Date.now() in here.
 *
 * Rules are evaluated in ascending position and the first match decides. A
 * rule's conditions are conjunctive — every condition it sets must hold — and
 * a condition it leaves empty is not a condition at all.
 */
export function evaluatePolicy(
  rules: PolicyRule[],
  fallback: PolicyFallback,
  context: AuthContext,
): PolicyDecision {
  const ordered = [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.position - b.position);

  for (const rule of ordered) {
    if (!ruleMatches(rule, context)) continue;

    // A require_factor rule with no factor named cannot be honoured as
    // written. Demanding some factor is the safe reading; silently allowing
    // would turn a corrupt row into a bypass.
    if (rule.outcome === 'require_factor' && rule.factorType === null) {
      return {
        outcome: 'require_mfa',
        factorType: null,
        ruleId: rule.id,
        ruleName: rule.name,
      };
    }

    return {
      outcome: rule.outcome,
      factorType: rule.outcome === 'require_factor' ? rule.factorType : null,
      ruleId: rule.id,
      ruleName: rule.name,
    };
  }

  return {
    outcome: fallback.outcome,
    factorType: fallback.outcome === 'require_factor' ? fallback.factorType : null,
    ruleId: null,
    ruleName: null,
  };
}
