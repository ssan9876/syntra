import { describe, expect, it } from 'vitest';
import {
  DIFF_LIMITATION,
  diffSnapshots,
  regionCovers,
  type DiffHolding,
  type DiffInput,
} from './diff.js';

const holding = (over: Partial<DiffHolding> = {}): DiffHolding => ({
  subjectKey: 'person:p-1',
  personId: 'p-1',
  accountRef: null,
  systemId: 'sys-1',
  resourceKind: 'targetEntitlement',
  resourceId: 'ent-finance',
  resourceName: 'Finance-Payments',
  state: 'held',
  attributionKinds: ['business_rule'],
  attributionRefs: ['business_rule:rule-finance'],
  ...over,
});

const diff = (over: Partial<DiffInput> = {}) =>
  diffSnapshots({ before: [], after: [], afterGapRegions: [], beforeGapRegions: [], ...over });

describe('the four ordinary changes', () => {
  it('reports a gain when a holding appears in a region that was read', () => {
    const events = diff({ after: [holding()] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ change: 'gained', resourceName: 'Finance-Payments' });
    expect(events[0]!.afterAttributions).toEqual(['business_rule:rule-finance']);
    expect(events[0]!.beforeAttributions).toEqual([]);
  });

  it('reports a loss when a holding disappears from a region that was read', () => {
    const events = diff({ before: [holding()] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ change: 'lost' });
  });

  it('reports an attribution change when the holding stands and its reasons move', () => {
    const events = diff({
      before: [holding()],
      after: [holding({ attributionKinds: ['business_rule', 'request'], attributionRefs: ['business_rule:rule-finance', 'request:grant-1'] })],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ change: 'attribution_changed' });
    expect(events[0]!.beforeAttributions).toEqual(['business_rule:rule-finance']);
    expect(events[0]!.afterAttributions).toEqual(['business_rule:rule-finance', 'request:grant-1']);
  });

  it('reports NOTHING when nothing moved', () => {
    expect(diff({ before: [holding()], after: [holding()] })).toEqual([]);
  });

  it('is insensitive to the order attributions arrive in', () => {
    // The collector's ordering is a query-plan detail. A diff that reported an
    // attribution_changed every night because the rows came back in a different
    // order would bury every real change in noise.
    const events = diff({
      before: [holding({ attributionRefs: ['request:g-1', 'business_rule:r-1'] })],
      after: [holding({ attributionRefs: ['business_rule:r-1', 'request:g-1'] })],
    });
    expect(events).toEqual([]);
  });
});

describe('became_unknown is NOT a loss', () => {
  it('reports became_unknown when the holding vanishes into a region the new snapshot could not read', () => {
    // This is the assertion the task exists for. Reporting `lost` here turns a
    // read failure into "their access was removed" — a change report that
    // announces a revocation nobody performed, about access the person still
    // has.
    const events = diff({
      before: [holding()],
      after: [],
      afterGapRegions: [{ systemId: 'sys-1', resourceId: 'ent-finance', personId: null }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.change).toBe('became_unknown');
  });

  it('reports became_unknown when the holding is present with state unknown', () => {
    const events = diff({
      before: [holding()],
      after: [holding({ state: 'unknown' })],
    });
    expect(events[0]!.change).toBe('became_unknown');
  });

  it('reports became_known when a holding recovers from unknown to held', () => {
    const events = diff({
      before: [holding({ state: 'unknown' })],
      after: [holding()],
    });
    expect(events[0]!.change).toBe('became_known');
  });

  it('reports NO gain when a holding appears out of a region the OLD snapshot could not read', () => {
    // Symmetric, and the one an implementation written from one side always
    // misses. If we could not see the region last night, the holding did not
    // "appear" — we simply looked properly for the first time. Calling that a
    // gain produces an `unexplained_gain` finding about access that has been
    // there for two years, on every source that has ever had an outage.
    const events = diff({
      before: [],
      after: [holding()],
      beforeGapRegions: [{ systemId: 'sys-1', resourceId: 'ent-finance', personId: null }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.change).toBe('became_known');
  });

  it('still reports a loss when the gap is in a DIFFERENT region', () => {
    const events = diff({
      before: [holding()],
      after: [],
      afterGapRegions: [{ systemId: 'sys-2', resourceId: 'ent-other', personId: null }],
    });
    expect(events[0]!.change).toBe('lost');
  });

  it('honours a person-scoped gap, which is what a person_unprocessable produces', () => {
    const events = diff({
      before: [holding()],
      after: [],
      afterGapRegions: [{ systemId: 'sys-1', resourceId: null, personId: 'p-1' }],
    });
    expect(events[0]!.change).toBe('became_unknown');
  });

  it('honours a system-wide gap, which is what a source_unread produces', () => {
    const events = diff({
      before: [holding()],
      after: [],
      afterGapRegions: [{ systemId: 'sys-1', resourceId: null, personId: null }],
    });
    expect(events[0]!.change).toBe('became_unknown');
  });
});

describe('regionCovers', () => {
  it('matches a whole system when resource and person are null', () => {
    expect(regionCovers({ systemId: 'sys-1', resourceId: null, personId: null }, holding())).toBe(true);
  });

  it('does not match a different system', () => {
    expect(regionCovers({ systemId: 'sys-2', resourceId: null, personId: null }, holding())).toBe(false);
  });

  it('matches only the named resource when one is given', () => {
    expect(regionCovers({ systemId: 'sys-1', resourceId: 'ent-finance', personId: null }, holding())).toBe(true);
    expect(regionCovers({ systemId: 'sys-1', resourceId: 'ent-other', personId: null }, holding())).toBe(false);
  });

  it('does not match a person-scoped region against an unattributed account', () => {
    const orphan = holding({ subjectKey: 'account:sys-1:anchor-7', personId: null, accountRef: 'anchor-7' });
    expect(regionCovers({ systemId: 'sys-1', resourceId: null, personId: 'p-1' }, orphan)).toBe(false);
  });
});

describe('unattributed accounts diff too', () => {
  it('reports a gain against an orphan account subject', () => {
    const events = diff({
      after: [holding({ subjectKey: 'account:sys-1:anchor-7', personId: null, accountRef: 'anchor-7' })],
    });
    expect(events[0]).toMatchObject({ change: 'gained', personId: null, accountRef: 'anchor-7' });
  });

  it('does not pair an orphan with a person holding the same resource', () => {
    const events = diff({
      before: [holding()],
      after: [holding({ subjectKey: 'account:sys-1:anchor-7', personId: null, accountRef: 'anchor-7' })],
    });
    expect(events.map((e) => e.change).sort()).toEqual(['gained', 'lost']);
  });
});

describe('the limitation is stated rather than hidden', () => {
  it('names the invisible case in words', () => {
    expect(DIFF_LIMITATION).toContain('reversed entirely between two snapshots');
  });
});
