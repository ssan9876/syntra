import type { TenantClient } from '@syntra/db';

/**
 * Suggesting business rules from what people already hold.
 *
 * **The problem is that rules are written from memory.** An organization
 * arrives with four thousand people who already hold things, and somebody has
 * to work out which of those holdings are a policy and which are an accident.
 * Done by hand that means reading a spreadsheet; done from a snapshot it is
 * arithmetic.
 *
 * Every output here is a SUGGESTION and nothing acts on one. A rule mined
 * from current state and applied automatically would encode the accidents
 * along with the policy — including the ones a certification campaign is
 * about to revoke — so the entire value is in showing somebody a candidate
 * with its numbers attached and letting them decide.
 */

export type MiningField = 'department' | 'jobTitle' | 'location' | 'employer';

export const MINING_FIELDS: MiningField[] = [
  'department',
  'jobTitle',
  'location',
  'employer',
];

/** One person, as the miner sees them. */
export interface MiningSubject {
  personId: string;
  department: string | null;
  jobTitle: string | null;
  location: string | null;
  employer: string | null;
  /** What they hold, as `resourceKind:resourceId`. */
  holdings: readonly string[];
}

export interface RuleCandidate {
  field: MiningField;
  value: string;
  resourceKey: string;
  resourceName: string;
  /** People matching the field value who hold it. */
  holders: number;
  /** People matching the field value at all. */
  population: number;
  /**
   * `holders / population`. How true the rule already is.
   *
   * The number to argue about: at 1.0 the rule describes the population
   * exactly, and below the threshold it is a coincidence with a large
   * denominator.
   */
  confidence: number;
  /**
   * Holders of this resource who are NOT in the population.
   *
   * The other half of the question, and the half a confidence figure hides. A
   * rule at 100% confidence over eight people, where forty others hold the
   * same thing for unrelated reasons, is not a description of that resource —
   * it is a description of eight people.
   */
  outsideHolders: number;
}

export interface MiningOptions {
  /**
   * The share of a population that must already hold something.
   *
   * 0.8 by default rather than 1.0, deliberately. A rule that only surfaces
   * where every single person already holds the thing surfaces almost nothing:
   * real populations have a leaver mid-notice, a contractor, somebody whose
   * account was created last week. The exceptions are the point — they are
   * what an administrator looks at before agreeing.
   */
  minConfidence?: number | undefined;
  /**
   * The smallest population worth a rule.
   *
   * Below this the arithmetic stops meaning anything: three out of three is
   * 100% confidence and no evidence at all, and a page of those buries the
   * candidates that matter.
   */
  minPopulation?: number | undefined;
  /** How many to return. */
  limit?: number | undefined;
  /**
   * The persons the caller may see, or null for all of them.
   *
   * Applied to the HOLDINGS query rather than to the finished candidates, so a
   * scoped reader's confidence figures are computed over their own population
   * and not filtered out of somebody else's. Filtering afterwards would leave
   * `outsideHolders` counting people the reader is not allowed to know exist.
   */
  personIds?: readonly string[] | null | undefined;
}

const DEFAULTS = { minConfidence: 0.8, minPopulation: 5, limit: 50 };

/**
 * Finds the rules the data already implies.
 *
 * Pure: no database, no clock. Everything it needs is in `subjects`, which is
 * what makes the thresholds arguable in a test rather than only observable
 * against a production snapshot.
 *
 * A value of `null` on a field is not a population. "Everybody whose
 * department is unset holds X" is a statement about a gap in the HR feed, not
 * a rule somebody should be offered.
 */
export function mineRuleCandidates(
  subjects: readonly MiningSubject[],
  resourceNames: ReadonlyMap<string, string>,
  options: MiningOptions = {},
): RuleCandidate[] {
  const minConfidence = options.minConfidence ?? DEFAULTS.minConfidence;
  const minPopulation = options.minPopulation ?? DEFAULTS.minPopulation;
  const limit = options.limit ?? DEFAULTS.limit;

  // How many people hold each resource in total, so a candidate can report
  // what sits outside its own population.
  const totalHolders = new Map<string, number>();
  for (const subject of subjects) {
    for (const holding of new Set(subject.holdings)) {
      totalHolders.set(holding, (totalHolders.get(holding) ?? 0) + 1);
    }
  }

  const candidates: RuleCandidate[] = [];

  for (const field of MINING_FIELDS) {
    // Group people by this field's value.
    const populations = new Map<string, MiningSubject[]>();
    for (const subject of subjects) {
      const value = subject[field];
      // A missing value is a gap in the feed, not a cohort.
      if (value === null || value.trim() === '') continue;
      const key = value.trim();
      populations.set(key, [...(populations.get(key) ?? []), subject]);
    }

    for (const [value, population] of populations) {
      if (population.length < minPopulation) continue;

      const held = new Map<string, number>();
      for (const subject of population) {
        for (const holding of new Set(subject.holdings)) {
          held.set(holding, (held.get(holding) ?? 0) + 1);
        }
      }

      for (const [resourceKey, holders] of held) {
        const confidence = holders / population.length;
        if (confidence < minConfidence) continue;

        candidates.push({
          field,
          value,
          resourceKey,
          resourceName: resourceNames.get(resourceKey) ?? resourceKey,
          holders,
          population: population.length,
          confidence,
          outsideHolders: (totalHolders.get(resourceKey) ?? 0) - holders,
        });
      }
    }
  }

  // Strongest first, then largest. A candidate covering four hundred people at
  // 0.95 is worth more attention than one covering six at 1.0, and sorting on
  // confidence alone would bury it.
  return candidates
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.population - a.population ||
        a.resourceName.localeCompare(b.resourceName),
    )
    .slice(0, limit);
}

/**
 * Loads the facts for one snapshot and mines it.
 *
 * Reads from a Govern SNAPSHOT rather than from live tables, and that is the
 * point: a snapshot is a consistent picture with a time on it, so a candidate
 * can be argued about against the same evidence twice. Mining live tables
 * would produce different numbers every time somebody refreshed the page.
 */
export async function mineFromSnapshot(
  tx: TenantClient,
  snapshotId: string,
  options: MiningOptions = {},
): Promise<RuleCandidate[]> {
  const holdings = await tx.holding.findMany({
    // `state: 'held'` only. An `unknown` holding is one the reading system
    // could not confirm, and mining it would treat "we could not tell" as
    // evidence that somebody holds something — which is how a rule comes to be
    // suggested from a target that was unreachable.
    //
    // `personId: { not: null }` excludes orphan accounts for the same kind of
    // reason: an account nobody is attached to has no department to correlate
    // with, and counting it would deflate every confidence figure it touches.
    where: {
      snapshotId,
      state: 'held',
      personId:
        options.personIds == null ? { not: null } : { in: [...options.personIds] },
    },
    select: { personId: true, resourceKind: true, resourceId: true, resourceName: true },
  });
  if (holdings.length === 0) return [];

  const personIds = [...new Set(holdings.map((h) => h.personId!))];
  const persons = await tx.person.findMany({
    where: { id: { in: personIds } },
    select: {
      id: true,
      contracts: {
        where: { isPrimary: true },
        select: { department: true, jobTitle: true, location: true, employer: true },
        take: 1,
      },
    },
  });

  const byPerson = new Map<string, string[]>();
  const resourceNames = new Map<string, string>();
  for (const holding of holdings) {
    const key = `${holding.resourceKind}:${holding.resourceId}`;
    resourceNames.set(key, holding.resourceName);
    byPerson.set(holding.personId!, [...(byPerson.get(holding.personId!) ?? []), key]);
  }

  const subjects: MiningSubject[] = persons.map((person) => {
    // The PRIMARY contract. A person with several is described by the one
    // marked primary; taking whichever came back first would make the same
    // person land in a different cohort on different runs.
    const contract = person.contracts[0];
    return {
      personId: person.id,
      department: contract?.department ?? null,
      jobTitle: contract?.jobTitle ?? null,
      location: contract?.location ?? null,
      employer: contract?.employer ?? null,
      holdings: byPerson.get(person.id) ?? [],
    };
  });

  return mineRuleCandidates(subjects, resourceNames, options);
}
