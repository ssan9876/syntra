/**
 * The closed vocabularies every Govern module speaks, and the counting
 * discipline that makes `unknown` impossible to render as a zero.
 *
 * Every union here mirrors a CHECK constraint in
 * `20260822000000_govern_inventory` or `20260823000000_govern_campaigns`
 * exactly. If one moves, both move.
 *
 * PURE. This module imports nothing. A value import from `@syntra/db` here
 * means the boundary is wrong, and Task 7 has a test that says so.
 */

/**
 * Two values, not three. `not_held` is the ABSENCE of a row, and only within a
 * region coverage says was read; everywhere else absence means `unknown`.
 * Storing an explicit `not_held` would multiply the row count by the size of
 * the resource catalog and destroy the very distinction it looks like it
 * preserves, because an unread region would then produce no row at all.
 */
export type HoldingState = 'held' | 'unknown';

export type ResourceKind =
  | 'targetEntitlement'
  | 'targetAccount'
  | 'syntraGroup'
  | 'application'
  | 'syntraRole'
  | 'syntraUser';

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'targetEntitlement',
  'targetAccount',
  'syntraGroup',
  'application',
  'syntraRole',
  'syntraUser',
];

export type SystemKind = 'targetSystem' | 'syntraInternal' | 'directorySource';
export type SourceKind = SystemKind;

/**
 * Core's own groups, applications, roles and user accounts are a system Govern
 * inventories, and they have no `TargetSystem` row. `systemId` is therefore a
 * text column, and this is the value it takes for them.
 */
export const SYNTRA_SYSTEM_ID = 'syntra';

export type AttributionKind =
  | 'business_rule'
  | 'request'
  | 'delegated_admin'
  | 'auto_granted'
  | 'direct_assignment'
  | 'group_inheritance'
  | 'org_unit_inheritance'
  | 'directory_source'
  | 'discovered'
  | 'manual'
  | 'unattributable';

export const ATTRIBUTION_KINDS: readonly AttributionKind[] = [
  'business_rule',
  'request',
  'delegated_admin',
  'auto_granted',
  'direct_assignment',
  'group_inheritance',
  'org_unit_inheritance',
  'directory_source',
  'discovered',
  'manual',
  'unattributable',
];

export type CoverageGapKind =
  | 'source_unread'
  | 'source_stale'
  | 'resource_unreadable'
  | 'account_unreadable'
  | 'subject_unresolvable'
  | 'person_unprocessable';

export const COVERAGE_GAP_KINDS: readonly CoverageGapKind[] = [
  'source_unread',
  'source_stale',
  'resource_unreadable',
  'account_unreadable',
  'subject_unresolvable',
  'person_unprocessable',
];

export type Completeness = 'complete' | 'partial' | 'unread';
export type Staleness = 'fresh' | 'stale';

/**
 * Section 16's closed set, with two deliberate departures from its kind table,
 * both amended in the spec at Task 1 Step 13:
 *
 *  - `audit_chain_broken` is HERE and is not in section 16. It is the audit
 *    integrity alarm, and it needs a kind of its own for a structural reason
 *    rather than a taxonomic one: `snapshot-service.ts`'s detect stage sweeps
 *    `STANDING_KINDS` on every nightly build, `coverage_gap` is a member, and
 *    the only `coverage_gap` producer emits `subjectRefType: 'source'`. Raising
 *    the two `critical` findings of Task 10 under `coverage_gap` therefore had
 *    the nightly build resolve them, naming a snapshot that had shown nothing.
 *    That is C1's defect at the two sites C5's fix created. `audit_chain_broken`
 *    is absent from `STANDING_KINDS` and must stay absent; Task 10 closes it
 *    itself, from evidence a snapshot build does not have.
 *  - `lapsed_exception` is NOT here, and section 16 lists it. Section 15 rule 3
 *    puts a lapse on the violation's OWN `sod_violation` finding — reopened at
 *    original severity, raised one step, `lapsedExceptionAt` stamped into its
 *    detail — which is what `lapse()` implements. A second kind would be two
 *    rows and two counts behind one problem, which is the exact thing Task 8A
 *    exists to prevent. Section 15 is the operative text (Ruling G-13).
 */
export type FindingKind =
  | 'unattributable_holding'
  | 'unexplained_gain'
  | 'access_without_contract'
  | 'orphan_account'
  | 'privileged_uncertified'
  | 'stale_source'
  | 'coverage_gap'
  | 'campaign_low_coverage'
  | 'dispatch_not_applied'
  | 'sod_violation'
  | 'sod_laundering'
  | 'approval_reciprocity'
  | 'audit_chain_broken'
  | 'no_human_decision'
  | 'unmergeable_actor';

export const FINDING_KINDS: readonly FindingKind[] = [
  'unattributable_holding',
  'unexplained_gain',
  'access_without_contract',
  'orphan_account',
  'privileged_uncertified',
  'stale_source',
  'coverage_gap',
  'campaign_low_coverage',
  'dispatch_not_applied',
  'sod_violation',
  'sod_laundering',
  'approval_reciprocity',
  'audit_chain_broken',
  'no_human_decision',
  'unmergeable_actor',
];

/**
 * The two `audit_chain_broken` subject references, as prefixes.
 *
 * Exported because TWO modules must agree on them: `audit-integrity.ts` writes
 * `${AUDIT_CHECKPOINT_REF}${sequence}` and `${AUDIT_CHAIN_REF}${sequence}`, and
 * `finding-service.ts` parses them back to decide which of those findings a
 * clean run is entitled to close. A second literal in either place is how the
 * writer and the reader start disagreeing about the same string — the shape
 * that cost this programme a Critical when a guard and a holder map read the
 * same fact from two sources.
 */
export const AUDIT_CHECKPOINT_REF = 'audit-checkpoint:';
export const AUDIT_CHAIN_REF = 'audit-chain:';

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

/**
 * Section 15: a violation somebody once formally accepted and then let quietly
 * expire is a different and worse thing than one nobody has looked at yet.
 */
export function raiseSeverity(severity: Severity): Severity {
  const index = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(index + 1, SEVERITY_ORDER.length - 1)]!;
}

/**
 * A helper that turns a declared type relationship into a compile error when it
 * stops holding. `type _ = MutuallyAssignable<A, B>` fails to compile unless A
 * and B are assignable in both directions.
 *
 * This exists because `z.ZodType<T>` over a `z.lazy` schema checks NOTHING —
 * Ruling P21 measured it: deleting an entire arm of the union still compiles
 * cleanly under that annotation. Anywhere this codebase looks like it is
 * proving a type relationship, it is proving it with one of these.
 */
//
// NOT `<A extends B, B extends A>`: that is a circular constraint and
// TypeScript refuses it outright (TS2313), so every guard written with it
// would be a compile error rather than a check. The conditional form below is
// the one already shipped in `automate/audience.ts` and `automate/form.ts`,
// where it was measured to fail on a real drift.
export type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
export type SubjectRef =
  | { kind: 'person'; personId: string }
  | { kind: 'account'; systemId: string; accountRef: string };

/**
 * The NOT NULL key every subject-bearing table carries beside its two nullable
 * subject columns.
 *
 * Two reasons, and they are the same reason twice. A unique index over
 * nullable columns constrains nothing in PostgreSQL, and a GROUP BY over two
 * nullable columns quietly puts every unattributed account in one bucket.
 */
export function subjectKey(subject: SubjectRef): string {
  return subject.kind === 'person'
    ? `person:${subject.personId}`
    : `account:${subject.systemId}:${subject.accountRef}`;
}

/**
 * The inverse. Returns null rather than guessing, because a key this cannot
 * parse is a bug somewhere upstream and inventing a subject for it would move
 * the bug somewhere harder to find.
 *
 * `accountRef` may itself contain colons — a second connector family may
 * return a distinguished name — so only the FIRST TWO separators are
 * significant and everything after them is the ref.
 */
export function parseSubjectKey(key: string): SubjectRef | null {
  if (key.startsWith('person:')) {
    const personId = key.slice('person:'.length);
    return personId.length > 0 ? { kind: 'person', personId } : null;
  }
  if (key.startsWith('account:')) {
    const rest = key.slice('account:'.length);
    const split = rest.indexOf(':');
    if (split <= 0) return null;
    const systemId = rest.slice(0, split);
    const accountRef = rest.slice(split + 1);
    return accountRef.length > 0 ? { kind: 'account', systemId, accountRef } : null;
  }
  return null;
}

export interface ResourceRef {
  systemKind: SystemKind;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
}

/**
 * Includes the kind, deliberately. A `Group` and an `Application` in Core can
 * hold the same uuid in principle and certainly hold the same shape, and a key
 * that omitted the kind would merge two different resources into one row of
 * every grouped report.
 */
export function resourceKey(resource: ResourceRef): string {
  return `${resource.systemId}|${resource.resourceKind}|${resource.resourceId}`;
}
/**
 * A value that may not be knowable, carrying the reason when it is not.
 *
 * The reason is not decoration. "Unknown" with no explanation is a dead end on
 * a screen somebody has to act from; "unknown, because the domain controller
 * was last read nine days ago against a 24-hour SLA" is a sentence with a next
 * step in it.
 */
export type Tri<T> = { known: true; value: T } | { known: false; reason: string };

export function known<T>(value: T): Tri<T> {
  return { known: true, value };
}

export function unknownValue<T>(reason: string): Tri<T> {
  return { known: false, reason };
}

export function mapTri<A, B>(input: Tri<A>, f: (a: A) => B): Tri<B> {
  return input.known ? { known: true, value: f(input.value) } : input;
}

/**
 * One region of the world, as far as one snapshot could see it.
 *
 * `held` is the count of holdings observed present. `unknownHoldings` is the
 * count of holdings whose STATE could not be determined. `gapReasons` is every
 * CoverageGap intersecting this region, in words.
 */
export interface CountableRegion {
  held: number;
  unknownHoldings: number;
  gapReasons: readonly string[];
}

/**
 * The one function that turns a region into a number, and the reason there is
 * no other.
 *
 * Any code path that wants a count goes through here, so there is exactly one
 * place where "we could not read the group" could become "nobody is in the
 * group" — and it does not. Section 8 rule 3 requires that no aggregation path
 * collapses `unknown` into `not_held`; the way to make that true rather than
 * promised is a return type that cannot express a bare number for a region
 * with a gap in it.
 *
 * A completely-read region with nothing in it counts zero. The empty case is
 * not the unknown case, and refusing to say so would make every honest zero
 * look like a failure.
 */
export function countRegion(region: CountableRegion): Tri<number> {
  if (region.gapReasons.length > 0) {
    return unknownValue(region.gapReasons.join('; '));
  }
  if (region.unknownHoldings > 0) {
    return unknownValue(
      `${region.unknownHoldings} holding(s) in this scope have an unknown state`,
    );
  }
  return known(region.held);
}

/** One unknown region poisons the total, and the total says which one. */
export function sumRegions(regions: readonly CountableRegion[]): Tri<number> {
  let total = 0;
  const reasons: string[] = [];
  for (const region of regions) {
    const count = countRegion(region);
    if (count.known) total += count.value;
    else reasons.push(count.reason);
  }
  return reasons.length > 0 ? unknownValue(reasons.join('; ')) : known(total);
}

/**
 * A percentage that carries its own denominator, because "94% certified" with
 * an unstated denominator is the sentence that makes an audit go badly — the
 * denominator turns out to have been "of items that were assigned to a
 * reviewer who was still employed".
 *
 * A zero denominator is unknown rather than zero or NaN. There is no honest
 * percentage of nothing.
 */
export function percentOf(
  numerator: number,
  denominator: Tri<number>,
): Tri<{ percent: number; numerator: number; denominator: number }> {
  if (!denominator.known) return denominator;
  if (denominator.value === 0) {
    return unknownValue('no denominator: this scope contains nothing to be a share of');
  }
  return known({
    percent: Math.round((numerator / denominator.value) * 1000) / 10,
    numerator,
    denominator: denominator.value,
  });
}
