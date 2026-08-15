import ipaddr from 'ipaddr.js';

/**
 * Three answers, not two. A condition can hold, fail to hold, or be
 * undecidable — and the third is not the second. `ruleMatches` resolves
 * `unevaluable` differently depending on the rule's outcome; see evaluate.ts.
 */
export type ConditionResult = 'match' | 'no-match' | 'unevaluable';

/**
 * Whether a stored range is syntactically a range at all.
 *
 * A parse in a try/catch, which is what a syntax check is. The first draft
 * asked instead whether the range contained one of four probe addresses, and
 * so rejected 192.168.0.0/16, 172.16.0.0/12, 198.51.100.0/24 and every literal
 * host address — a matcher used as a validator answers a different question
 * than the one being asked.
 */
export function isIpRangeUsable(range: string): boolean {
  try {
    if (range.includes('/')) ipaddr.parseCIDR(range);
    else ipaddr.process(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `sourceIp` falls in any of `ranges`, which may hold CIDR notation or
 * bare addresses, IPv4 or IPv6.
 *
 * An empty list is not a condition at all: a rule that names no ranges is
 * unconstrained by address and holds for everything.
 *
 * Everything else that is not a clean hit or a clean miss is `unevaluable`: no
 * source address to test, a source address that will not parse, or a range
 * that will not parse. The caller decides what an undecidable condition means,
 * because the answer differs between a rule that lets people in and one that
 * keeps them out.
 *
 * ipaddr.js's match() throws when the families differ rather than returning
 * false, so kinds are compared before it is called.
 */
export function evaluateIpRanges(
  sourceIp: string | null,
  ranges: string[],
): ConditionResult {
  if (ranges.length === 0) return 'match';

  const usable = ranges.filter(isIpRangeUsable);
  if (usable.length === 0) return 'unevaluable';
  if (!sourceIp) return 'unevaluable';

  let addr: ReturnType<typeof ipaddr.process>;
  try {
    // process(), not parse(): it folds ::ffff:10.0.0.1 down to 10.0.0.1, which
    // is the shape a dual-stack listener reports for an IPv4 client.
    addr = ipaddr.process(sourceIp);
  } catch {
    return 'unevaluable';
  }

  for (const range of usable) {
    try {
      if (range.includes('/')) {
        const cidr = ipaddr.parseCIDR(range);
        if (cidr[0].kind() !== addr.kind()) continue;
        if (addr.match(cidr)) return 'match';
      } else {
        const other = ipaddr.process(range);
        if (other.kind() !== addr.kind()) continue;
        if (addr.toNormalizedString() === other.toNormalizedString()) return 'match';
      }
    } catch {
      continue;
    }
  }

  // Nothing hit. If part of the list could not be read, the rule covered
  // addresses this cannot see, and "no" would be an overstatement.
  return usable.length === ranges.length ? 'no-match' : 'unevaluable';
}

export const matchesIpRanges = (sourceIp: string | null, ranges: string[]): boolean =>
  evaluateIpRanges(sourceIp, ranges) === 'match';
