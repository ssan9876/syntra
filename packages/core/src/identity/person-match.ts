import type { TenantClient } from '@syntra/db';

export type MatchRule = 'businessEmail' | 'personalEmail' | 'displayName';

export interface PersonCandidate {
  personId: string;
  givenName: string;
  familyName: string;
  rule: MatchRule;
  /**
   * Whether this person already signs in somewhere.
   *
   * Reported rather than acted on, and that split is deliberate. The create
   * path demotes a confident match carrying it — auto-linking would silently
   * produce the second account the second-account warning exists for, without
   * the warning — while the suggestion list on an orphaned account still shows
   * it, because an administrator looking at an orphan may well be linking a
   * contractor's second account on purpose.
   */
  hasActiveAccount: boolean;
}

export interface PersonMatch {
  confident: PersonCandidate | null;
  candidates: PersonCandidate[];
}

/** Case- and whitespace-insensitive. `  Maya   OKAFOR ` is `maya okafor`. */
const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Which person, if any, this account belongs to.
 *
 * Distinct from `sync/correlate.ts`, which answers a different question:
 * correlation resolves a DIRECTORY OBJECT to a `User`, and this resolves a
 * `User` to a `Person`. They are not two implementations of one idea and are
 * deliberately not shared.
 *
 * Exactly one rule is strong enough to act on unasked. A business email is an
 * address the organization issued and controls, so a unique match on it is a
 * statement by the organization about who somebody is. A personal address is a
 * guess about somebody's private life, and two people share a name often
 * enough that treating a name match as an answer would eventually link a
 * joiner's account to their namesake's record — taking the group memberships,
 * entitlements and claim mappings that hang off a person with it.
 *
 * Ambiguity always demotes. Two rows matching the strong rule is not a strong
 * match; it is a data problem, and resolving it by taking the first would
 * resolve it differently depending on the query plan.
 *
 * No match returns nothing and says nothing. Silence is the default, because
 * the population this runs over includes every service account Syntra will
 * ever hold, and a suggestion on each of them would train people to dismiss
 * the control.
 */
export async function matchPersonForAccount(
  tx: TenantClient,
  input: { email: string; displayName: string },
): Promise<PersonMatch> {
  const email = key(input.email);
  const name = key(input.displayName);

  // Nothing to match on. Guarded here rather than per-rule so a service
  // account created with neither cannot sweep up whoever happens to have a
  // blank field.
  if (!email && !name) return { confident: null, candidates: [] };

  const people = await tx.person.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      givenName: true,
      familyName: true,
      businessEmail: true,
      personalEmail: true,
    },
  });

  // One query for the whole set rather than one per candidate: a person with
  // several accounts would otherwise be read once per account, and the caller
  // that most needs this runs it over every unlinked account at once.
  const withAccounts = new Set(
    (
      await tx.user.findMany({
        where: { status: 'active', personId: { not: null } },
        select: { personId: true },
      })
    ).map((row) => row.personId!),
  );

  const build = (
    row: (typeof people)[number],
    rule: MatchRule,
  ): PersonCandidate => ({
    personId: row.id,
    givenName: row.givenName,
    familyName: row.familyName,
    rule,
    hasActiveAccount: withAccounts.has(row.id),
  });

  const byBusiness = email
    ? people.filter((p) => p.businessEmail && key(p.businessEmail) === email)
    : [];

  if (byBusiness.length === 1) {
    return { confident: build(byBusiness[0]!, 'businessEmail'), candidates: [] };
  }

  const byPersonal = email
    ? people.filter((p) => p.personalEmail && key(p.personalEmail) === email)
    : [];
  const byName = name
    ? people.filter((p) => key(`${p.givenName} ${p.familyName}`) === name)
    : [];

  // Deduplicated by person, keeping the strongest rule that matched them: a
  // person whose work and personal addresses are the same string should appear
  // once, described by the better reason.
  const seen = new Map<string, PersonCandidate>();
  for (const [rule, rows] of [
    ['businessEmail', byBusiness],
    ['personalEmail', byPersonal],
    ['displayName', byName],
  ] as const) {
    for (const row of rows) {
      if (!seen.has(row.id)) seen.set(row.id, build(row, rule));
    }
  }

  return { confident: null, candidates: [...seen.values()] };
}
