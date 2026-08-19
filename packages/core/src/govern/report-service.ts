import { withTenant, type TenantClient } from '@syntra/db';
import { summariseAttributions, type AttributionDraft } from './attribute.js';
import { DIFF_LIMITATION } from './diff.js';
import { readableSnapshot, snapshotBracket, type ReadableSnapshot } from './readable.js';
import { countRegion, type ResourceKind, type Tri } from './types.js';

export interface ReportSourceLine {
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  lastSuccessfulReadAt: string | null;
  completeness: string;
  staleness: string;
  ageHours: number | null;
  gapCount: number;
}

export interface ReportHeader {
  snapshotId: string;
  /** When GOVERN assembled the picture. NOT any holding's observedAt. */
  asOf: string;
  live: false;
  sources: ReportSourceLine[];
  coverageGapCount: number;
  unattributableCount: number;
  unattributedAccountCount: number;
  scopeDescription: string;
}

export interface LiveReportHeader {
  live: true;
  computedAt: string;
  /** A live report cannot be exported as evidence: it has no as-of time. */
  exportable: false;
  caveat: string;
}

declare const REPORT_BRAND: unique symbol;

/**
 * A report body that CANNOT be constructed without its header.
 *
 * Section 8 rule 4: "The report DTO has no constructor that omits it. A number
 * without this header is not a number this product produces." A convention that
 * lives in a document is a convention that survives until the third person
 * touches the code, so the rule is a private brand instead: `envelope` is the
 * only function that can produce one, and a bare `{ header, body }` literal is
 * a type error.
 */
export interface ReportEnvelope<T> {
  readonly [REPORT_BRAND]: true;
  header: ReportHeader | LiveReportHeader;
  body: T;
}

/**
 * THE BRAND IS A TYPE-LEVEL WITNESS AND IS NEVER WRITTEN AT RUNTIME.
 *
 * `declare const REPORT_BRAND: unique symbol` emits NO RUNTIME BINDING. A
 * computed key `{ [REPORT_BRAND]: true, … }` evaluates `REPORT_BRAND` at
 * runtime and throws `ReferenceError: REPORT_BRAND is not defined` on the first
 * report call. It compiles, so `tsc -b --force` is clean and the failure
 * surfaces as a library-looking crash — the same signature Ruling P19 measured
 * for the `as never` defects.
 *
 * The risk is not the crash; it is the fix an implementer reaches for.
 * REMOVING THE BRAND makes it work and destroys §8 rule 4's only enforcement
 * ("the report DTO has no constructor that omits it"), and the Step 9 mutation
 * that watches for the brand's removal then passes too. So: the object is a
 * plain `{ header, body }` and the cast is what attaches the brand. The brand
 * exists in the type system and nowhere else, which is all it ever needed to.
 */
export function envelope<T>(header: ReportHeader | LiveReportHeader, body: T): ReportEnvelope<T> {
  return { header, body } as ReportEnvelope<T>;
}

export function headerOf<T>(e: ReportEnvelope<T>): ReportHeader | LiveReportHeader {
  return e.header;
}

export function bodyOf<T>(e: ReportEnvelope<T>): T {
  return e.body;
}

export function buildHeader(snapshot: ReadableSnapshot, scopeDescription: string): ReportHeader {
  return {
    snapshotId: snapshot.id,
    asOf: snapshot.asOf.toISOString(),
    live: false,
    sources: snapshot.sources.map((s) => ({
      sourceKind: s.sourceKind,
      sourceId: s.sourceId,
      sourceName: s.sourceName,
      lastSuccessfulReadAt: s.lastSuccessfulReadAt?.toISOString() ?? null,
      completeness: s.completeness,
      staleness: s.staleness,
      ageHours: s.ageHours,
      gapCount: s.gapCount,
    })),
    coverageGapCount: snapshot.coverageGapCount,
    unattributableCount: snapshot.unattributableCount,
    unattributedAccountCount: snapshot.unattributedAccountCount,
    scopeDescription,
  };
}

export interface SystemAccessRow {
  subjectKey: string;
  personId: string | null;
  displayName: string;
  bucket: 'unattributable' | 'no_active_contract' | 'unattributed_account' | 'other';
  resources: {
    resourceKind: ResourceKind;
    resourceId: string;
    resourceName: string;
    state: string;
    observedAt: string;
    provenance: string;
    lastCertifiedAt: string | null;
    lastCertifiedBy: string | null;
  }[];
}

const BUCKET_ORDER = [
  'unattributable',
  'no_active_contract',
  'unattributed_account',
  'other',
] as const;

export async function whoHasAccessToSystem(
  tenantId: string,
  input: { snapshotId?: string; systemId: string; resourceId?: string },
): Promise<ReportEnvelope<{ rows: SystemAccessRow[]; holderCount: Tri<number> }>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const holdings = await tx.holding.findMany({
      where: {
        snapshotId: snapshot.id,
        systemId: input.systemId,
        ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      },
      include: { attributions: true },
    });
    const gaps = await tx.coverageGap.findMany({
      where: {
        snapshotId: snapshot.id,
        systemId: input.systemId,
        ...(input.resourceId === undefined
          ? {}
          : { OR: [{ resourceId: input.resourceId }, { resourceId: null }] }),
      },
      select: { reason: true },
    });
    const persons = await tx.person.findMany({
      select: { id: true, givenName: true, familyName: true },
    });
    const contracts = await tx.contract.findMany({
      select: { personId: true, startDate: true, endDate: true },
    });
    const certifications = await tx.holdingCertification.findMany({
      where: { systemId: input.systemId },
    });
    return { snapshot, holdings, gaps, persons, contracts, certifications };
  });

  const nameById = new Map(
    loaded.persons.map((p) => [p.id, `${p.givenName} ${p.familyName}`.trim()]),
  );
  const now = loaded.snapshot.asOf;
  const hasActiveContract = new Set(
    loaded.contracts
      .filter((c) => c.startDate <= now && (c.endDate === null || c.endDate >= now))
      .map((c) => c.personId),
  );
  const certifiedByKey = new Map(
    loaded.certifications.map((c) => [`${c.subjectRefId}|${c.resourceKind}|${c.resourceId}`, c]),
  );

  const bySubject = new Map<string, SystemAccessRow>();
  for (const holding of loaded.holdings) {
    const existing = bySubject.get(holding.subjectKey);
    const certification = certifiedByKey.get(
      `${holding.personId ?? holding.accountRef ?? ''}|${holding.resourceKind}|${holding.resourceId}`,
    );

    const resource = {
      resourceKind: holding.resourceKind as ResourceKind,
      resourceId: holding.resourceId,
      resourceName: holding.resourceName,
      state: holding.state,
      // The holding's OWN truth-time, which can be days from the snapshot's
      // as-of, and both are on the report.
      observedAt: holding.observedAt.toISOString(),
      provenance: summariseAttributions(
        holding.attributions.map((a) => ({
          kind: a.kind as AttributionDraft['kind'],
          refType: a.refType,
          refId: a.refId,
          detail: a.detail as Record<string, unknown>,
          resolvedAt: a.resolvedAt,
        })),
      ),
      lastCertifiedAt: certification?.lastCertifiedAt.toISOString() ?? null,
      lastCertifiedBy:
        certification === undefined
          ? null
          : (nameById.get(certification.lastCertifiedByPersonId) ?? null),
    };

    if (existing !== undefined) {
      existing.resources.push(resource);
      if (holding.unattributable) existing.bucket = 'unattributable';
      continue;
    }

    const bucket: SystemAccessRow['bucket'] = holding.unattributable
      ? 'unattributable'
      : holding.personId === null
        ? 'unattributed_account'
        : hasActiveContract.has(holding.personId)
          ? 'other'
          : 'no_active_contract';

    bySubject.set(holding.subjectKey, {
      subjectKey: holding.subjectKey,
      personId: holding.personId,
      displayName:
        holding.personId === null
          ? `an account with no person (${holding.accountRef ?? 'unknown'})`
          : (nameById.get(holding.personId) ?? 'a person no longer recorded'),
      bucket,
      resources: [resource],
    });
  }

  const rows = [...bySubject.values()].sort((a, b) => {
    const byBucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);
    return byBucket !== 0 ? byBucket : a.displayName.localeCompare(b.displayName);
  });

  // The count goes through `countRegion` and through nothing else, so a gap in
  // this scope makes it `unknown` rather than a confident number.
  const holderCount = countRegion({
    held: rows.filter((r) => r.resources.some((x) => x.state === 'held')).length,
    unknownHoldings: loaded.holdings.filter((h) => h.state === 'unknown').length,
    gapReasons: loaded.gaps.map((g) => g.reason),
  });

  return envelope(
    buildHeader(
      loaded.snapshot,
      `system ${input.systemId}${input.resourceId ? `, resource ${input.resourceId}` : ''}`,
    ),
    { rows, holderCount },
  );
}

export type SnapshotInForce =
  | { covered: true; snapshot: ReadableSnapshot }
  | { covered: false; nearest: Date | null; statement: string };

/**
 * The snapshot IN FORCE on a date: the most recent complete snapshot whose
 * `asOf` is at or before it, and which is not so far before it that it says
 * nothing about that day.
 *
 * A DISCRIMINATED UNION, not a nullable snapshot and not "the nearest one".
 * §9 asks "what did Anna hold on 14 March"; answering with 2 April's picture
 * because it is the closest available is the failure this function exists to
 * refuse. The caller cannot reach `snapshot` without narrowing on `covered`.
 *
 * "Covers" means: there is a snapshot at or before the date, AND the next
 * snapshot after it is no more than `maxGapDays` later — otherwise the date
 * sits in a gap between two builds and nothing observed the world on it.
 */
export async function snapshotInForceOn(
  tx: TenantClient,
  date: Date,
  options: { maxGapDays?: number } = {},
): Promise<SnapshotInForce> {
  const maxGapDays = options.maxGapDays ?? 2;

  const { before, after } = await snapshotBracket(tx, date);

  const iso = date.toISOString().slice(0, 10);

  if (before === null) {
    return {
      covered: false,
      nearest: after?.asOf ?? null,
      statement:
        after === null
          ? `no snapshot covers ${iso}: this tenant has no complete snapshot at all`
          : `no snapshot covers ${iso}: the earliest complete snapshot is ${after.asOf
              .toISOString()
              .slice(0, 10)}, which is after that date`,
    };
  }

  const gapDays =
    after === null
      ? (date.getTime() - before.asOf.getTime()) / 86_400_000
      : (after.asOf.getTime() - before.asOf.getTime()) / 86_400_000;

  if (gapDays > maxGapDays) {
    return {
      covered: false,
      nearest: before.asOf,
      statement:
        `no snapshot covers ${iso}: the nearest is ${before.asOf.toISOString().slice(0, 10)} and the ` +
        `next is ${after === null ? 'none' : after.asOf.toISOString().slice(0, 10)}, a gap of ` +
        `${Math.round(gapDays)} days. Reporting either one as the picture on ${iso} would be a ` +
        `different date wearing this one's label.`,
    };
  }

  return { covered: true, snapshot: await readableSnapshot(tx, before.id) };
}

/**
 * Thrown rather than returned, because `whatDoesPersonHold` promises an
 * envelope and there is no honest envelope for a date nothing observed. The
 * refusal carries the whole `covered: false` branch, so the route can print the
 * statement that names the gap instead of a generic 404.
 */
export class SnapshotNotCoveredError extends Error {
  constructor(
    readonly on: Date,
    readonly detail: Extract<SnapshotInForce, { covered: false }>,
  ) {
    super(detail.statement);
    this.name = 'SnapshotNotCoveredError';
  }
}

export interface AccountDormancy {
  userId: string;
  login: string;
  lastSuccessfulSignInAt: string | null;
  lastAttemptAt: string | null;
  dormantDays: number | null;
  caveat: string;
}

const DORMANCY_CAVEAT =
  'This is SYNTRA ACCOUNT dormancy: when this person last signed in to Syntra. ' +
  'It is NOT entitlement usage. It says nothing about whether they used the access ' +
  'this report lists, at the target systems that hold it, and a person who has not ' +
  'signed in to Syntra for a year may have used every one of these entitlements today.';

/**
 * Set-based over the person's users. Two queries, not one per user.
 */
export async function accountDormancy(
  tx: TenantClient,
  personId: string,
  now: Date,
): Promise<AccountDormancy[]> {
  const users = await tx.user.findMany({
    where: { personId },
    select: { id: true, login: true },
  });
  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);

  const sessions = await tx.session.groupBy({
    by: ['userId'],
    where: { userId: { in: ids } },
    _max: { createdAt: true },
  });
  const attempts = await tx.authAttempt.groupBy({
    by: ['userId'],
    where: { userId: { in: ids } },
    _max: { createdAt: true },
  });
  const lastSession = new Map(sessions.map((s) => [s.userId, s._max.createdAt]));
  const lastAttempt = new Map(attempts.map((a) => [a.userId, a._max.createdAt]));

  return users.map((user) => {
    const signedIn = lastSession.get(user.id) ?? null;
    return {
      userId: user.id,
      login: user.login,
      lastSuccessfulSignInAt: signedIn?.toISOString() ?? null,
      lastAttemptAt: lastAttempt.get(user.id)?.toISOString() ?? null,
      dormantDays:
        signedIn === null ? null : Math.floor((now.getTime() - signedIn.getTime()) / 86_400_000),
      caveat: DORMANCY_CAVEAT,
    };
  });
}

export interface PersonHoldingRow {
  systemKind: string;
  systemId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  state: string;
  privileged: boolean;
  observedAt: string;
  observedVia: string;
  firstSeenAt: string;
  provenance: string;
  attributions: { kind: string; detail: Record<string, unknown> }[];
  lastCertifiedAt: string | null;
}

export async function whatDoesPersonHold(
  tenantId: string,
  input: { snapshotId?: string; personId: string; on?: Date },
): Promise<
  ReportEnvelope<{
    personId: string;
    displayName: string;
    accounts: string[];
    holdings: PersonHoldingRow[];
    dormancy: AccountDormancy[];
  }>
> {
  const loaded = await withTenant(tenantId, async (tx) => {
    let snapshot = await readableSnapshot(tx, input.snapshotId);
    // A point-in-time question is answered by the snapshot in force on that
    // date or refused. Substituting the nearest one would be a different date
    // wearing this one's label, and the substitution is invisible.
    if (input.on !== undefined) {
      const inForce = await snapshotInForceOn(tx, input.on);
      if (!inForce.covered) throw new SnapshotNotCoveredError(input.on, inForce);
      snapshot = inForce.snapshot;
    }
    const person = await tx.person.findUniqueOrThrow({ where: { id: input.personId } });
    const holdings = await tx.holding.findMany({
      where: { snapshotId: snapshot.id, personId: input.personId },
      include: { attributions: true },
      orderBy: [{ systemId: 'asc' }, { resourceKind: 'asc' }, { resourceName: 'asc' }],
    });
    const certifications = await tx.holdingCertification.findMany({
      where: { subjectRefType: 'person', subjectRefId: input.personId },
    });
    const dormancy = await accountDormancy(tx, input.personId, input.on ?? snapshot.asOf);
    return { snapshot, person, holdings, certifications, dormancy };
  });

  const certifiedByKey = new Map(
    loaded.certifications.map((c) => [
      `${c.systemId}|${c.resourceKind}|${c.resourceId}`,
      c.lastCertifiedAt,
    ]),
  );

  return envelope(
    buildHeader(
      loaded.snapshot,
      `everything ${loaded.person.givenName} ${loaded.person.familyName} holds`,
    ),
    {
      personId: input.personId,
      displayName: `${loaded.person.givenName} ${loaded.person.familyName}`.trim(),
      // The other accounts, if the person holds several.
      accounts: [
        ...new Set(
          loaded.holdings
            .filter((h) => h.resourceKind === 'targetAccount')
            .map((h) => `${h.systemId}:${h.resourceId}`),
        ),
      ],
      holdings: loaded.holdings.map((h) => ({
        systemKind: h.systemKind,
        systemId: h.systemId,
        resourceKind: h.resourceKind as ResourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        state: h.state,
        privileged: h.privileged,
        observedAt: h.observedAt.toISOString(),
        observedVia: h.observedVia,
        firstSeenAt: h.firstSeenAt.toISOString(),
        provenance: summariseAttributions(
          h.attributions.map((a) => ({
            kind: a.kind as AttributionDraft['kind'],
            refType: a.refType,
            refId: a.refId,
            detail: a.detail as Record<string, unknown>,
            resolvedAt: a.resolvedAt,
          })),
        ),
        // The FULL attribution set, not the first one.
        attributions: h.attributions.map((a) => ({
          kind: a.kind,
          detail: a.detail as Record<string, unknown>,
        })),
        lastCertifiedAt:
          certifiedByKey.get(`${h.systemId}|${h.resourceKind}|${h.resourceId}`)?.toISOString() ??
          null,
      })),
      // Rendered under its OWN heading with the caveat printed, never as a
      // column beside the holdings: a dormancy figure sitting in a table of
      // entitlements reads as a statement about those entitlements, which is
      // exactly what §16 says it is not.
      dormancy: loaded.dormancy,
    },
  );
}

export interface ChangeReport {
  fromSnapshotId: string;
  toSnapshotId: string;
  snapshotsOverPeriod: number;
  limitation: string;
  /** Two panes that are never merged. */
  observedChanges: {
    subjectKey: string;
    resourceName: string;
    change: string;
    explained: boolean;
    auditEventSequence: number | null;
  }[];
  recordedActions: {
    sequence: number;
    action: string;
    occurredAt: string;
    actorUserId: string | null;
  }[];
  /** An action with no observed change: usually a write that reported success and did not land. */
  actionsWithNoObservedChange: number;
}

export async function whatChanged(
  tenantId: string,
  input: { fromSnapshotId: string; toSnapshotId: string },
): Promise<ReportEnvelope<ChangeReport>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const to = await readableSnapshot(tx, input.toSnapshotId);
    const from = await readableSnapshot(tx, input.fromSnapshotId);
    const events = await tx.holdingEvent.findMany({
      where: { fromSnapshotId: input.fromSnapshotId, toSnapshotId: input.toSnapshotId },
    });
    const audit = await tx.auditEvent.findMany({
      where: { occurredAt: { gte: from.asOf, lte: to.asOf } },
      orderBy: { sequence: 'asc' },
      select: { sequence: true, action: true, occurredAt: true, actorUserId: true },
    });
    const snapshotsOverPeriod = await tx.accessSnapshot.count({
      where: { status: 'complete', asOf: { gte: from.asOf, lte: to.asOf } },
    });
    return { to, from, events, audit, snapshotsOverPeriod };
  });

  const explainedSequences = new Set(
    loaded.events.map((e) => e.auditEventSequence).filter((s): s is number => s !== null),
  );

  return envelope(buildHeader(loaded.to, 'changes over the period'), {
    fromSnapshotId: input.fromSnapshotId,
    toSnapshotId: input.toSnapshotId,
    // "What changed in Q2, from 91 daily snapshots" is a defensible sentence;
    // "what changed in Q2" is not.
    snapshotsOverPeriod: loaded.snapshotsOverPeriod,
    limitation: DIFF_LIMITATION,
    observedChanges: loaded.events.map((e) => ({
      subjectKey: e.subjectKey,
      resourceName: e.resourceName,
      change: e.change,
      explained: e.explained,
      auditEventSequence: e.auditEventSequence,
    })),
    recordedActions: loaded.audit.map((a) => ({
      sequence: a.sequence,
      action: a.action,
      occurredAt: a.occurredAt.toISOString(),
      actorUserId: a.actorUserId,
    })),
    actionsWithNoObservedChange: loaded.audit.filter((a) => !explainedSequences.has(a.sequence))
      .length,
  });
}

export interface ApprovalReport {
  hasApprovalRecord: boolean;
  statement: string;
  attributionKinds: string[];
  requests: {
    requestId: string | null;
    productName: string | null;
    requesterName: string | null;
    justification: string | null;
    endsAt: string | null;
    approvers: { personName: string; decision: string; decidedAt: string; comment: string | null }[];
  }[];
}

export async function whoApprovedIt(
  tenantId: string,
  input: {
    snapshotId?: string;
    subjectKey: string;
    systemId: string;
    resourceKind: ResourceKind;
    resourceId: string;
  },
): Promise<ReportEnvelope<ApprovalReport>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const holding = await tx.holding.findFirst({
      where: {
        snapshotId: snapshot.id,
        subjectKey: input.subjectKey,
        systemId: input.systemId,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
      },
      include: { attributions: true },
    });
    return { snapshot, holding };
  });

  const attributions = loaded.holding?.attributions ?? [];
  const approvalKinds = ['request', 'delegated_admin', 'auto_granted'];
  const relevant = attributions.filter((a) => approvalKinds.includes(a.kind));

  return envelope(buildHeader(loaded.snapshot, 'who approved this holding'), {
    hasApprovalRecord: relevant.length > 0,
    // For a birthright entitlement this sentence is the CORRECT answer, and for
    // an unattributable one it is the finding. It is not a failure of the report.
    statement:
      relevant.length > 0
        ? 'this access was requested and decided; every stage and decision is below'
        : `no approval record exists for this holding. It is explained by: ${
            attributions.length === 0
              ? 'nothing at all'
              : attributions.map((a) => a.kind).join(', ')
          }`,
    attributionKinds: attributions.map((a) => a.kind),
    requests: relevant.map((a) => {
      const detail = a.detail as Record<string, unknown>;
      return {
        requestId: (detail['requestId'] as string | null) ?? null,
        productName: (detail['productName'] as string | null) ?? null,
        requesterName: (detail['requesterName'] as string | null) ?? null,
        justification: (detail['justification'] as string | null) ?? null,
        endsAt: (detail['endsAt'] as string | null) ?? null,
        approvers:
          (detail['approvers'] as ApprovalReport['requests'][number]['approvers'] | undefined) ?? [],
      };
    }),
  });
}
