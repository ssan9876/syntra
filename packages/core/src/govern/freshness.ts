import type { Completeness, CoverageGapKind, SourceKind, Staleness } from './types.js';

/**
 * Freshness, staleness and the coverage rollup.
 *
 * THERE ARE TWO CLOCKS AND THEY ARE NOT THE SAME CLOCK.
 *
 * `freshnessSlaHours` is per source and measures how long ago THE WORLD was
 * read. `maxSnapshotAgeDays` is per tenant and measures how long ago GOVERN
 * assembled the picture. A snapshot built five minutes ago from a target read
 * three weeks ago fails the first and passes the second; a snapshot built five
 * weeks ago from sources that were all fresh at the time fails the second and
 * passes the first. Both are checked, separately, and a refusal always names
 * which one it was.
 *
 * PURE.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export interface SourceObservation {
  sourceKind: SourceKind;
  sourceId: string;
  sourceName: string;
  lastRunId: string | null;
  lastSuccessfulReadAt: Date | null;
  lastAttemptedReadAt: Date | null;
  completeness: Completeness;
  freshnessSlaHours: number;
  gapCount: number;
}

export interface ClassifiedSource extends SourceObservation {
  staleness: Staleness;
  /** Null when the source has never been read successfully. */
  ageHours: number | null;
}

export function classifySource(
  observation: SourceObservation,
  asOf: Date,
): ClassifiedSource {
  // Automate's grants, Core's groups, roles and users live in the same
  // database and are current by construction. Stating that is better than
  // leaving a blank that a reader interprets as an omission.
  if (observation.sourceKind === 'syntraInternal') {
    return { ...observation, completeness: 'complete', staleness: 'fresh', ageHours: 0 };
  }

  if (observation.lastSuccessfulReadAt === null) {
    return { ...observation, completeness: 'unread', staleness: 'stale', ageHours: null };
  }

  const ageHours =
    (asOf.getTime() - observation.lastSuccessfulReadAt.getTime()) / MS_PER_HOUR;

  // Exactly at the SLA is INSIDE it. A boundary that flips at the instant it
  // is reached makes a 24-hour source stale for one tick every day.
  return {
    ...observation,
    staleness: ageHours <= observation.freshnessSlaHours ? 'fresh' : 'stale',
    ageHours,
  };
}

export function classifySources(
  observations: readonly SourceObservation[],
  asOf: Date,
): ClassifiedSource[] {
  return observations.map((o) => classifySource(o, asOf));
}

const COMPLETENESS_RANK: Record<Completeness, number> = {
  complete: 0,
  partial: 1,
  unread: 2,
};

/**
 * The snapshot takes the WORST of its sources, and an empty list is `unread`.
 *
 * The empty case is the one that matters. A snapshot with no SnapshotSource
 * rows has not been shown to have read anything, and calling that "complete"
 * is the false-assurance defect in its purest form — it is what a build that
 * silently collected nothing would produce.
 */
export function worstCompleteness(sources: readonly ClassifiedSource[]): Completeness {
  if (sources.length === 0) return 'unread';
  return sources.reduce<Completeness>(
    (worst, s) => (COMPLETENESS_RANK[s.completeness] > COMPLETENESS_RANK[worst] ? s.completeness : worst),
    'complete',
  );
}

/** Same reasoning: an empty list is `stale`, not `fresh`. */
export function worstStaleness(sources: readonly ClassifiedSource[]): Staleness {
  if (sources.length === 0) return 'stale';
  return sources.some((s) => s.staleness === 'stale') ? 'stale' : 'fresh';
}

export interface SourceGapDraft {
  kind: CoverageGapKind;
  sourceKind: SourceKind;
  sourceId: string;
  reason: string;
  sourceRunId: string | null;
}

/**
 * One gap per source that cannot be described, and AT MOST ONE per source.
 *
 * An unread source is also, trivially, past its SLA, and reporting both would
 * put "nine days stale" on a screen about something nobody has ever read —
 * which sends the reader looking for a run that does not exist.
 */
export function gapsForSources(sources: readonly ClassifiedSource[]): SourceGapDraft[] {
  const gaps: SourceGapDraft[] = [];
  for (const s of sources) {
    if (s.lastSuccessfulReadAt === null) {
      gaps.push({
        kind: 'source_unread',
        sourceKind: s.sourceKind,
        sourceId: s.sourceId,
        reason: `${s.sourceName} has never been read successfully; nothing it holds is described by this snapshot`,
        sourceRunId: s.lastRunId,
      });
      continue;
    }
    if (s.staleness === 'stale') {
      gaps.push({
        kind: 'source_stale',
        sourceKind: s.sourceKind,
        sourceId: s.sourceId,
        reason:
          `${s.sourceName} was last read ${Math.round(s.ageHours ?? 0)} hours ago, ` +
          `against a freshness SLA of ${s.freshnessSlaHours} hours`,
        sourceRunId: s.lastRunId,
      });
    }
  }
  return gaps;
}
export type SnapshotAgeVerdict =
  | { ok: true; ageDays: number }
  | { ok: false; ageDays: number; clock: 'snapshot'; message: string };

/**
 * The tenant clock. Section 8 rule 2, and section 13's first outright refusal.
 *
 * There is nothing an administrator could usefully confirm about executing
 * decisions made against a picture of the world from six weeks ago; the answer
 * is to re-base and let the reviewers look at what changed.
 */
export function checkSnapshotAge(
  asOf: Date,
  now: Date,
  maxSnapshotAgeDays: number,
): SnapshotAgeVerdict {
  const ageDays = Math.floor((now.getTime() - asOf.getTime()) / MS_PER_DAY);
  if (ageDays <= maxSnapshotAgeDays) return { ok: true, ageDays };
  return {
    ok: false,
    ageDays,
    clock: 'snapshot',
    message:
      `this snapshot was assembled ${ageDays} days ago, past the limit of ` +
      `${maxSnapshotAgeDays} days. Re-base onto a fresh snapshot; re-basing ` +
      `re-opens only the items whose holding actually changed.`,
  };
}

export type SourceFreshnessVerdict =
  | { ok: true }
  | { ok: false; clock: 'source'; offending: ClassifiedSource[]; message: string };

/**
 * The world clock. Section 8 rule 1, and section 13's second outright refusal.
 *
 * Somebody about to ask 200 managers to attest to something has to be
 * attesting to something true, so this is a refusal and not a warning the
 * campaign owner can dismiss.
 *
 * An EMPTY list refuses. A campaign whose scope depends on no source at all is
 * a campaign over a scope nobody has established anything about.
 */
export function checkSourceFreshness(
  sources: readonly ClassifiedSource[],
): SourceFreshnessVerdict {
  if (sources.length === 0) {
    return {
      ok: false,
      clock: 'source',
      offending: [],
      message:
        'no source contributes to this scope, so nothing here has been shown to have been read',
    };
  }

  const offending = sources.filter(
    (s) => s.staleness === 'stale' || s.completeness === 'unread',
  );
  if (offending.length === 0) return { ok: true };

  return {
    ok: false,
    clock: 'source',
    offending,
    message: offending
      .map((s) =>
        s.lastSuccessfulReadAt === null
          ? `${s.sourceName} has never been read successfully`
          : `${s.sourceName} was last read ${Math.round(s.ageHours ?? 0)} hours ago, against a ${s.freshnessSlaHours}-hour SLA`,
      )
      .join('; '),
  };
}
