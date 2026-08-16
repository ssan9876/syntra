import { evaluateIpRanges } from '../policy/ip-match.js';
import { evaluateTimeWindow } from '../policy/time-window.js';

/**
 * A rule that says which upstream identity provider a login goes to.
 *
 * Stored in `AuthPolicyRule` with `outcome = 'federate'` so an administrator
 * sees one ordered list, but loaded into its own type and evaluated by its own
 * function. Its conditions are only the ones knowable before a user has been
 * identified — spec section 8's group and contract conditions are deliberately
 * absent, because at routing time there is no user to look them up for.
 * `policy-service.ts` refuses to save a federate rule that carries one.
 */
export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  upstreamIdpId: string;
  applicationIds: string[];
  /** The domain part of the login identifier, lower case, no leading '@'. */
  loginDomains: string[];
  ipRanges: string[];
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
}

export interface RoutingContext {
  /** What the user typed. Null when nothing was typed — an app launch. */
  login: string | null;
  applicationId: string | null;
  sourceIp: string | null;
  now: Date;
}

export interface RoutingDecision {
  upstreamIdpId: string;
  ruleId: string;
  ruleName: string;
}

/** The part after the last '@', lower-cased. Null when there is no '@'. */
function loginDomain(login: string | null): string | null {
  if (login === null) return null;
  const at = login.lastIndexOf('@');
  if (at < 0 || at === login.length - 1) return null;
  return login.slice(at + 1).toLowerCase();
}

function matchesDomain(rule: RoutingRule, login: string | null): boolean {
  if (rule.loginDomains.length === 0) return true;
  const domain = loginDomain(login);
  if (domain === null) return false;
  // Exact equality on the whole domain label set. A suffix match would send
  // `x@notacme.test` to acme's upstream, which hands a stranger's browser to
  // a tenant's identity provider and leaks the tenant's federation topology.
  return rule.loginDomains.some((allowed) => allowed.toLowerCase() === domain);
}

function matchesApplication(rule: RoutingRule, applicationId: string | null): boolean {
  if (rule.applicationIds.length === 0) return true;
  if (applicationId === null) return false;
  return rule.applicationIds.includes(applicationId);
}

/**
 * Picks the upstream for a login that has not happened yet, or null for local
 * authentication.
 *
 * Pure, like `evaluatePolicy`, and for the same reason.
 *
 * **An undecidable condition means no match.** This is the opposite of
 * `ruleMatches`'s treatment of a `deny` rule, and deliberately so: routing
 * grants nothing, so failing towards "do not federate" leaves the user at the
 * local login screen rather than at a provider whose conditions could not be
 * checked. A tenant whose users have no local password sees a failed login
 * rather than a wrongly-routed one, and a failed login is visible.
 *
 * **This function never authorizes anything.** Its result decides where the
 * browser goes. Whether the person who comes back may have a session is
 * `authorize()`'s decision and nothing here anticipates it.
 */
export function evaluateRouting(
  rules: RoutingRule[],
  context: RoutingContext,
): RoutingDecision | null {
  const ordered = [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.position - b.position);

  for (const rule of ordered) {
    if (!matchesApplication(rule, context.applicationId)) continue;
    if (!matchesDomain(rule, context.login)) continue;
    if (evaluateIpRanges(context.sourceIp, rule.ipRanges) !== 'match') continue;
    if (evaluateTimeWindow(rule, context.now) !== 'match') continue;

    return { upstreamIdpId: rule.upstreamIdpId, ruleId: rule.id, ruleName: rule.name };
  }

  return null;
}
