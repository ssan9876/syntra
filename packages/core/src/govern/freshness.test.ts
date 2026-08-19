import { describe, expect, it } from 'vitest';
import {
  checkSnapshotAge,
  checkSourceFreshness,
  classifySource,
  classifySources,
  gapsForSources,
  worstCompleteness,
  worstStaleness,
  type SourceObservation,
} from './freshness.js';

const AS_OF = new Date('2026-06-15T09:00:00Z');
const hoursBefore = (h: number) => new Date(AS_OF.getTime() - h * 3600_000);

const source = (over: Partial<SourceObservation> = {}): SourceObservation => ({
  sourceKind: 'targetSystem',
  sourceId: 'sys-1',
  sourceName: 'Acme AD',
  lastRunId: 'run-1',
  lastSuccessfulReadAt: hoursBefore(2),
  lastAttemptedReadAt: hoursBefore(2),
  completeness: 'complete',
  freshnessSlaHours: 24,
  gapCount: 0,
  ...over,
});

describe('classifySource — the boundaries', () => {
  it('is fresh just inside the SLA', () => {
    const c = classifySource(source({ lastSuccessfulReadAt: hoursBefore(23.9) }), AS_OF);
    expect(c.staleness).toBe('fresh');
  });

  it('is fresh exactly at the SLA', () => {
    // Exactly at is inside. A boundary that flips at the instant it is reached
    // makes a 24-hour source stale for one tick every day, which trains people
    // to ignore the badge.
    const c = classifySource(source({ lastSuccessfulReadAt: hoursBefore(24) }), AS_OF);
    expect(c.staleness).toBe('fresh');
    expect(c.ageHours).toBe(24);
  });

  it('is stale just outside the SLA', () => {
    const c = classifySource(source({ lastSuccessfulReadAt: hoursBefore(24.1) }), AS_OF);
    expect(c.staleness).toBe('stale');
  });

  it('is unread and stale when it has never been read successfully', () => {
    const c = classifySource(
      source({ lastSuccessfulReadAt: null, lastAttemptedReadAt: hoursBefore(1), completeness: 'unread' }),
      AS_OF,
    );
    expect(c).toMatchObject({ completeness: 'unread', staleness: 'stale', ageHours: null });
  });

  it('is stale and unread when a source has never been attempted at all', () => {
    const c = classifySource(
      source({ lastSuccessfulReadAt: null, lastAttemptedReadAt: null, completeness: 'unread' }),
      AS_OF,
    );
    expect(c.staleness).toBe('stale');
  });

  it('keeps `partial` when the read succeeded but did not see everything', () => {
    // Read recently AND incompletely: fresh on one axis, partial on the other,
    // and conflating them is how a truncated read becomes a complete report.
    const c = classifySource(
      source({ lastSuccessfulReadAt: hoursBefore(1), completeness: 'partial', gapCount: 2 }),
      AS_OF,
    );
    expect(c).toMatchObject({ staleness: 'fresh', completeness: 'partial' });
  });

  it('treats syntraInternal as always fresh and always complete, whatever it was handed', () => {
    // Automate's grants live in the same database and are current by
    // construction. Saying so explicitly is better than leaving a blank a
    // reader interprets as an omission.
    const c = classifySource(
      source({
        sourceKind: 'syntraInternal',
        sourceId: 'syntra',
        lastSuccessfulReadAt: null,
        completeness: 'unread',
        freshnessSlaHours: 1,
      }),
      AS_OF,
    );
    expect(c).toMatchObject({ staleness: 'fresh', completeness: 'complete' });
  });
});

describe('rollups take the worst', () => {
  it('takes the worst completeness across sources', () => {
    const sources = classifySources(
      [source(), source({ sourceId: 'sys-2', completeness: 'partial' })],
      AS_OF,
    );
    expect(worstCompleteness(sources)).toBe('partial');
  });

  it('ranks unread below partial', () => {
    const sources = classifySources(
      [source({ completeness: 'partial' }), source({ sourceId: 'sys-2', completeness: 'unread', lastSuccessfulReadAt: null })],
      AS_OF,
    );
    expect(worstCompleteness(sources)).toBe('unread');
  });

  it('is stale if any source is stale', () => {
    const sources = classifySources(
      [source(), source({ sourceId: 'sys-2', lastSuccessfulReadAt: hoursBefore(200) })],
      AS_OF,
    );
    expect(worstStaleness(sources)).toBe('stale');
  });

  it('reports an EMPTY source list as unread and stale, never as complete and fresh', () => {
    // The empty case is the universal case. A snapshot with no SnapshotSource
    // rows has not been shown to have read anything, and calling that
    // "complete" is the false-assurance defect in its purest form.
    expect(worstCompleteness([])).toBe('unread');
    expect(worstStaleness([])).toBe('stale');
  });
});

describe('gapsForSources', () => {
  it('produces one source_unread gap naming the source', () => {
    const [gap, ...rest] = gapsForSources(
      classifySources([source({ lastSuccessfulReadAt: null, completeness: 'unread' })], AS_OF),
    );
    expect(rest).toHaveLength(0);
    expect(gap).toMatchObject({ kind: 'source_unread', sourceId: 'sys-1' });
    expect(gap!.reason).toContain('Acme AD');
  });

  it('produces one source_stale gap carrying the age and the SLA in words', () => {
    const [gap] = gapsForSources(
      classifySources([source({ lastSuccessfulReadAt: hoursBefore(9 * 24) })], AS_OF),
    );
    expect(gap).toMatchObject({ kind: 'source_stale' });
    expect(gap!.reason).toContain('216');
    expect(gap!.reason).toContain('24');
  });

  it('produces no gap for a fresh, complete source', () => {
    expect(gapsForSources(classifySources([source()], AS_OF))).toEqual([]);
  });

  it('produces a source_unread gap, not a source_stale one, for a source never read', () => {
    // Both are true of an unread source and only one is useful. "Nine days
    // stale" about something never read is a sentence that sends somebody
    // looking for a run that does not exist.
    const gaps = gapsForSources(
      classifySources([source({ lastSuccessfulReadAt: null, completeness: 'unread' })], AS_OF),
    );
    expect(gaps.map((g) => g.kind)).toEqual(['source_unread']);
  });
});

describe('the two clocks, and which one a refusal names', () => {
  const NOW = new Date('2026-07-20T09:00:00Z');

  it('passes a snapshot inside maxSnapshotAgeDays', () => {
    expect(checkSnapshotAge(new Date('2026-07-01T09:00:00Z'), NOW, 30)).toEqual({
      ok: true,
      ageDays: 19,
    });
  });

  it('refuses a snapshot past maxSnapshotAgeDays and names the snapshot clock', () => {
    const verdict = checkSnapshotAge(new Date('2026-06-01T09:00:00Z'), NOW, 30);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.clock).toBe('snapshot');
    expect(verdict.message).toContain('49 days');
    expect(verdict.message).toContain('30');
  });

  it('separates the clocks: fresh sources, ancient snapshot', () => {
    // Built five weeks ago from sources that were all fresh AT THE TIME. Fails
    // the snapshot clock, passes the source clock.
    const sources = classifySources([source()], AS_OF);
    expect(checkSourceFreshness(sources).ok).toBe(true);
    expect(checkSnapshotAge(AS_OF, NOW, 30).ok).toBe(false);
  });

  it('separates the clocks the other way: minutes-old snapshot, three-week-old target', () => {
    const sources = classifySources(
      [source({ lastSuccessfulReadAt: hoursBefore(21 * 24) })],
      AS_OF,
    );
    const verdict = checkSourceFreshness(sources);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.clock).toBe('source');
    expect(verdict.offending.map((s) => s.sourceId)).toEqual(['sys-1']);
    expect(checkSnapshotAge(AS_OF, new Date(AS_OF.getTime() + 300_000), 30).ok).toBe(true);
  });

  it('refuses when a source in scope has never been read', () => {
    const sources = classifySources(
      [source({ lastSuccessfulReadAt: null, completeness: 'unread' })],
      AS_OF,
    );
    expect(checkSourceFreshness(sources).ok).toBe(false);
  });

  it('refuses an EMPTY source list rather than passing it', () => {
    const verdict = checkSourceFreshness([]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.message).toContain('no source');
  });
});
