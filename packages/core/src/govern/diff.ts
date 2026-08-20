import type { AttributionKind, HoldingState, ResourceKind } from './types.js';

/**
 * The change question, answered by diffing consecutive snapshots.
 *
 * The audit log is authoritative and records everything SYNTRA did. It says
 * nothing about anything Syntra did not do — a hand grant at a domain
 * controller produces no Syntra audit event, because Syntra was not involved.
 * Snapshot diffing sees that, and it is the only thing that structurally can.
 *
 * PURE.
 */

export type HoldingChange =
  | 'gained'
  | 'lost'
  | 'attribution_changed'
  | 'became_unknown'
  | 'became_known';

export interface DiffHolding {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  state: HoldingState;
  attributionKinds: readonly AttributionKind[];
  /** `kind:refId` per attribution, so a change of reason is comparable. */
  attributionRefs: readonly string[];
}

/**
 * A region of the world one snapshot could not describe, projected from its
 * CoverageGap rows.
 *
 * A null `resourceId` means the whole system; a null `personId` means every
 * subject. Both null is "this source was not read at all".
 */
export interface DiffRegion {
  systemId: string;
  resourceId: string | null;
  personId: string | null;
}

export interface DiffInput {
  before: readonly DiffHolding[];
  after: readonly DiffHolding[];
  /** Gaps in the LATER snapshot. A disappearance into one is not a loss. */
  afterGapRegions: readonly DiffRegion[];
  /** Gaps in the EARLIER snapshot. An appearance out of one is not a gain. */
  beforeGapRegions: readonly DiffRegion[];
}

export interface HoldingEventDraft {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  change: HoldingChange;
  beforeAttributions: readonly string[];
  afterAttributions: readonly string[];
}

export const DIFF_LIMITATION =
  'A change that happened and reversed entirely between two snapshots is ' +
  'invisible to this comparison. Somebody added to a group at 09:00 and ' +
  'removed at 16:00, with nightly snapshots, leaves no row here. Where the act ' +
  'went through Syntra the audit log has it and the recorded-actions pane shows ' +
  'it; where it did not, it is gone.';

export function regionCovers(region: DiffRegion, holding: DiffHolding): boolean {
  if (region.systemId !== holding.systemId) return false;
  if (region.resourceId !== null && region.resourceId !== holding.resourceId) return false;
  if (region.personId !== null && region.personId !== holding.personId) return false;
  return true;
}

function inAnyRegion(regions: readonly DiffRegion[], holding: DiffHolding): boolean {
  return regions.some((region) => regionCovers(region, holding));
}

/**
 * The comparison key. The subject key is already `person:<id>` or
 * `account:<systemId>:<ref>`, so an orphan account and a person holding the
 * same resource are two different rows here, which is correct — they are two
 * different subjects and merging them would report a revocation and a grant as
 * one silent no-op.
 */
function key(h: DiffHolding): string {
  return `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`;
}

/** Order-insensitive: the collector's ordering is a query-plan detail. */
function sameAttributions(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function draft(
  holding: DiffHolding,
  change: HoldingChange,
  beforeAttributions: readonly string[],
  afterAttributions: readonly string[],
): HoldingEventDraft {
  return {
    subjectKey: holding.subjectKey,
    personId: holding.personId,
    accountRef: holding.accountRef,
    systemId: holding.systemId,
    resourceKind: holding.resourceKind,
    resourceId: holding.resourceId,
    resourceName: holding.resourceName,
    change,
    beforeAttributions,
    afterAttributions,
  };
}

export function diffSnapshots(input: DiffInput): HoldingEventDraft[] {
  const beforeByKey = new Map(input.before.map((h) => [key(h), h]));
  const afterByKey = new Map(input.after.map((h) => [key(h), h]));
  const events: HoldingEventDraft[] = [];

  for (const [k, after] of afterByKey) {
    const before = beforeByKey.get(k);

    if (before === undefined) {
      // An appearance out of a region the OLD snapshot could not read is not a
      // gain. We did not watch access arrive; we looked properly for the first
      // time. Calling it a gain produces an `unexplained_gain` finding about
      // access that has been there for two years, on every source that has ever
      // had an outage.
      if (inAnyRegion(input.beforeGapRegions, after)) {
        events.push(draft(after, 'became_known', [], after.attributionRefs));
      } else if (after.state === 'unknown') {
        events.push(draft(after, 'became_unknown', [], after.attributionRefs));
      } else {
        events.push(draft(after, 'gained', [], after.attributionRefs));
      }
      continue;
    }

    if (before.state === 'held' && after.state === 'unknown') {
      events.push(draft(after, 'became_unknown', before.attributionRefs, after.attributionRefs));
      continue;
    }
    if (before.state === 'unknown' && after.state === 'held') {
      events.push(draft(after, 'became_known', before.attributionRefs, after.attributionRefs));
      continue;
    }
    if (!sameAttributions(before.attributionRefs, after.attributionRefs)) {
      events.push(
        draft(after, 'attribution_changed', before.attributionRefs, after.attributionRefs),
      );
    }
  }

  for (const [k, before] of beforeByKey) {
    if (afterByKey.has(k)) continue;

    // THE ASSERTION THIS MODULE EXISTS FOR. A disappearance into a region the
    // new snapshot could not read is `became_unknown`, never `lost`. Reporting
    // it as a loss turns a read failure into "their access was removed" — a
    // change report announcing a revocation nobody performed, about access the
    // person still has.
    events.push(
      inAnyRegion(input.afterGapRegions, before)
        ? draft(before, 'became_unknown', before.attributionRefs, [])
        : draft(before, 'lost', before.attributionRefs, []),
    );
  }

  return events;
}
