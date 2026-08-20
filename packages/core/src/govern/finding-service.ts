import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import type { ClassifiedSource } from './freshness.js';
import {
  AUDIT_CHAIN_REF,
  AUDIT_CHECKPOINT_REF,
  raiseSeverity,
  type FindingKind,
  type Severity,
} from './types.js';

/** Bounded so a tenant with 40,000 findings does not write them in one transaction. */
export const FINDING_BATCH = 200;

export interface FindingDraft {
  kind: FindingKind;
  severity: Severity;
  subjectRefType: string;
  subjectRefId: string;
  detail: Record<string, unknown>;
  /** A Provision DriftFinding this AGGREGATES, never copies. */
  driftFindingId?: string | null;
}

export interface DetectHolding {
  subjectKey: string;
  personId: string | null;
  accountRef: string | null;
  systemId: string;
  systemName: string;
  resourceKind: string;
  resourceId: string;
  resourceName: string;
  privileged: boolean;
  unattributable: boolean;
  attributionKinds: readonly string[];
}

export interface DetectContract {
  personId: string;
  startDate: Date;
  endDate: Date | null;
}

const holdingRef = (h: DetectHolding) =>
  `${h.subjectKey}|${h.systemId}|${h.resourceKind}|${h.resourceId}`;

/**
 * An unattributable holding is the single most interesting thing an access
 * review can find. It is what a hand grant looks like, what a compromised
 * administrator's persistence looks like, and what a system nobody remembers
 * configuring looks like.
 */
export function detectUnattributableHoldings(
  holdings: readonly DetectHolding[],
): FindingDraft[] {
  return holdings
    .filter((h) => h.unattributable)
    .map((h) => ({
      kind: 'unattributable_holding' as const,
      severity: (h.privileged ? 'critical' : 'high') as Severity,
      subjectRefType: 'holding',
      subjectRefId: holdingRef(h),
      detail: {
        subjectKey: h.subjectKey,
        systemId: h.systemId,
        systemName: h.systemName,
        // The target's own anchor for the account that holds it, when there is
        // one. Task 8A needs it to match this draft against Provision's
        // `unmanaged_entitlement` DriftFinding, which is keyed on
        // (targetSystemId, accountId, entitlementId) and not on a person.
        accountRef: h.accountRef,
        resourceKind: h.resourceKind,
        resourceId: h.resourceId,
        resourceName: h.resourceName,
        privileged: h.privileged,
        attributionKinds: [...h.attributionKinds],
      },
    }));
}

/**
 * The leaver finding, and the one this whole platform keeps rediscovering.
 *
 * THE SIGNATURE IS THE CONTROL. Three parameters: holdings, contracts, now.
 * There is deliberately no fourth. Automate's C1 kept a leaver's account
 * enabled forever by teaching desired state about grants; Provision's P23 froze
 * a leaver's deprovisioning behind an unrelated flag. Both were "something
 * unrelated to employment silently becoming the reason access persists after it
 * ends". This function CANNOT SEE the unrelated thing: no exception, no
 * certification, no accepted finding and no campaign item is in scope here, so
 * none of them can ever become evidence that somebody is still employed.
 *
 * Each subsystem correctly handles its own remit; nobody but Govern looks
 * across all of them at once.
 */
export function detectAccessWithoutContract(
  holdings: readonly DetectHolding[],
  contracts: readonly DetectContract[],
  now: Date,
): FindingDraft[] {
  const activeByPerson = new Map<string, boolean>();
  const knownPersons = new Set<string>();
  for (const contract of contracts) {
    knownPersons.add(contract.personId);
    const active = contract.startDate <= now && (contract.endDate === null || contract.endDate >= now);
    activeByPerson.set(contract.personId, (activeByPerson.get(contract.personId) ?? false) || active);
  }

  // A person whose contract has not STARTED is not departed. Provision's Ruling
  // P10 is the same distinction one subsystem over, and getting it wrong here
  // would put every pre-hire on the leaver list on their first day.
  const notYetStarted = new Set(
    contracts
      .filter((c) => c.startDate > now && (c.endDate === null || c.endDate >= now))
      .map((c) => c.personId),
  );

  const byPerson = new Map<string, DetectHolding[]>();
  for (const holding of holdings) {
    if (holding.personId === null) continue;
    if (activeByPerson.get(holding.personId) === true) continue;
    if (notYetStarted.has(holding.personId)) continue;
    byPerson.set(holding.personId, [...(byPerson.get(holding.personId) ?? []), holding]);
  }

  return [...byPerson].map(([personId, held]) => ({
    kind: 'access_without_contract' as const,
    severity: (held.some((h) => h.privileged) ? 'critical' : 'high') as Severity,
    subjectRefType: 'person',
    subjectRefId: personId,
    detail: {
      holdingCount: held.length,
      // A person with no contract row at all is a different and more
      // interesting case than one whose contract ended, and the finding says
      // which.
      hasAnyContractRecord: knownPersons.has(personId),
      holdings: held.map((h) => ({
        systemName: h.systemName,
        resourceKind: h.resourceKind,
        resourceName: h.resourceName,
        privileged: h.privileged,
      })),
    },
  }));
}

/**
 * A zero-stage workflow is a legitimate configuration, and the grant it
 * produces has no approver. Access nobody decided is precisely the access a
 * recertification exists to have somebody decide, so it is counted, listed and
 * campaigned first.
 */
export function detectNoHumanDecision(holdings: readonly DetectHolding[]): FindingDraft[] {
  return holdings
    .filter((h) => h.attributionKinds.includes('auto_granted'))
    .map((h) => ({
      kind: 'no_human_decision' as const,
      severity: (h.privileged ? 'high' : 'medium') as Severity,
      subjectRefType: 'holding',
      subjectRefId: holdingRef(h),
      detail: {
        subjectKey: h.subjectKey,
        resourceName: h.resourceName,
        systemName: h.systemName,
        note: 'this access was granted by a workflow with no approval stages; no human decided it',
      },
    }));
}

/** A source nobody has read is a report nobody should trust. A finding, not a badge. */
export function detectStaleSources(sources: readonly ClassifiedSource[]): FindingDraft[] {
  return sources
    .filter((s) => s.staleness === 'stale')
    .map((s) => ({
      kind: 'stale_source' as const,
      severity: (s.lastSuccessfulReadAt === null ? 'high' : 'medium') as Severity,
      subjectRefType: 'source',
      subjectRefId: s.sourceId,
      detail: {
        sourceKind: s.sourceKind,
        sourceName: s.sourceName,
        ageHours: s.ageHours,
        freshnessSlaHours: s.freshnessSlaHours,
        neverRead: s.lastSuccessfulReadAt === null,
      },
    }));
}

export function detectCoverageGaps(
  gaps: readonly { kind: string; systemId: string | null; resourceId: string | null; reason: string }[],
): FindingDraft[] {
  // One finding per gapped REGION, not per gap row, so a target with 400
  // unreadable groups produces 400 rows on the coverage screen and one row on
  // the findings queue — which is where somebody works down a list.
  const byRegion = new Map<string, { count: number; reason: string; systemId: string | null }>();
  for (const gap of gaps) {
    const key = `${gap.kind}|${gap.systemId ?? ''}`;
    const existing = byRegion.get(key);
    byRegion.set(key, {
      count: (existing?.count ?? 0) + 1,
      reason: existing?.reason ?? gap.reason,
      systemId: gap.systemId,
    });
  }
  return [...byRegion].map(([key, value]) => ({
    kind: 'coverage_gap' as const,
    severity: 'high' as Severity,
    subjectRefType: 'source',
    subjectRefId: key,
    detail: { gapCount: value.count, example: value.reason, systemId: value.systemId },
  }));
}

/** Access appeared, and Syntra did not cause it. */
export function detectUnexplainedGains(
  events: readonly {
    subjectKey: string; systemId: string; resourceKind: string;
    resourceId: string; resourceName: string; change: string; explained: boolean;
  }[],
): FindingDraft[] {
  return events
    .filter((e) => e.change === 'gained' && !e.explained)
    .map((e) => ({
      kind: 'unexplained_gain' as const,
      severity: 'high' as Severity,
      subjectRefType: 'holding',
      subjectRefId: `${e.subjectKey}|${e.systemId}|${e.resourceKind}|${e.resourceId}`,
      detail: {
        subjectKey: e.subjectKey,
        resourceName: e.resourceName,
        note: 'this access appeared between two snapshots and no Syntra audit event explains it',
      },
    }));
}

export function detectPrivilegedUncertified(
  holdings: readonly DetectHolding[],
  certifiedAt: ReadonlyMap<string, Date>,
  now: Date,
  privilegedRecertifyDays: number,
): FindingDraft[] {
  const cutoff = new Date(now.getTime() - privilegedRecertifyDays * 86_400_000);
  return holdings
    .filter((h) => h.privileged)
    .filter((h) => {
      const last = certifiedAt.get(holdingRef(h));
      return last === undefined || last < cutoff;
    })
    .map((h) => ({
      kind: 'privileged_uncertified' as const,
      severity: 'high' as Severity,
      subjectRefType: 'holding',
      subjectRefId: holdingRef(h),
      detail: {
        subjectKey: h.subjectKey,
        resourceName: h.resourceName,
        systemName: h.systemName,
        lastCertifiedAt: certifiedAt.get(holdingRef(h))?.toISOString() ?? null,
        privilegedRecertifyDays,
      },
    }));
}
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One lifecycle, one table, one count.
 *
 * A finding that persists across snapshots is UPDATED, not duplicated, so the
 * dashboard count is a count of problems and not a count of snapshots.
 *
 * THIS FUNCTION RESOLVES NOTHING. It has no `snapshotId` parameter and no
 * sweep, because a sweep here would be correct for exactly one caller and
 * catastrophic for the other five: every caller that passes a partial draft set
 * would close every finding it did not happen to be about. Resolution lives in
 * `reconcileFindings`, which is handed the kinds its caller is authoritative
 * for. See the table at the head of this task.
 *
 * An `accepted` finding is left alone. Re-opening it every night would make an
 * operator's deliberate risk acceptance a decision they had to re-make daily,
 * which is how people learn to close findings without reading them.
 */
export async function upsertFindings(
  tenantId: string,
  drafts: readonly FindingDraft[],
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ opened: number; updated: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? FINDING_BATCH;

  let opened = 0;
  let updated = 0;

  for (const batch of chunk(drafts, batchSize)) {
    await withTenant(tenantId, async (tx) => {
      for (const draft of batch) {
        const existing = await tx.governFinding.findUnique({
          where: {
            tenantId_kind_subjectRefType_subjectRefId: {
              tenantId,
              kind: draft.kind,
              subjectRefType: draft.subjectRefType,
              subjectRefId: draft.subjectRefId,
            },
          },
        });

        if (existing === null) {
          await tx.governFinding.create({
            data: {
              tenantId,
              kind: draft.kind,
              severity: draft.severity,
              subjectRefType: draft.subjectRefType,
              subjectRefId: draft.subjectRefId,
              detail: draft.detail as never,
              driftFindingId: draft.driftFindingId ?? null,
              firstSeenAt: now,
              lastSeenAt: now,
            },
          });
          opened += 1;
          continue;
        }

        if (existing.status === 'accepted') continue;

        await tx.governFinding.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: now,
            severity: draft.severity,
            detail: draft.detail as never,
            ...(existing.status === 'resolved'
              ? { status: 'open', resolvedAt: null, resolvedBySnapshotId: null }
              : {}),
          },
        });
        updated += 1;
      }
    });
  }

  return { opened, updated };
}

/**
 * Upsert, then close what this caller is authoritative for and nothing else.
 *
 * `kinds` is the whole control. The sweep reads only findings whose `kind` is
 * in `kinds`, so a caller that owns `unexplained_gain` cannot close an
 * `unattributable_holding` its sibling opened four lines earlier in the same
 * snapshot build. An empty `kinds` closes nothing; a `kinds` naming something
 * the caller did not compute drafts for closes all of it, which is why the
 * table at the head of this task is normative and why every call site names its
 * kinds inline rather than deriving them from `drafts`.
 *
 * Deriving them from `drafts` — `new Set(drafts.map(d => d.kind))` — is the
 * tempting simplification and it is wrong: a detector that legitimately
 * produces zero drafts this run would then never close last run's findings,
 * which is the case the resolution exists for.
 *
 * `resolvedBySnapshotId` names the snapshot that SHOWED IT GONE, per §16, so
 * only a caller running inside (or immediately after) a snapshot build may pass
 * one.
 */
export async function reconcileFindings(
  tenantId: string,
  snapshotId: string,
  kinds: readonly FindingKind[],
  drafts: readonly FindingDraft[],
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ opened: number; updated: number; resolved: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? FINDING_BATCH;

  const { opened, updated } = await upsertFindings(tenantId, drafts, options);

  if (kinds.length === 0) return { opened, updated, resolved: 0 };

  const seen = new Set(drafts.map((d) => `${d.kind}|${d.subjectRefType}|${d.subjectRefId}`));

  const stillOpen = await withTenant(tenantId, (tx) =>
    tx.governFinding.findMany({
      where: { status: { in: ['open', 'acknowledged'] }, kind: { in: [...kinds] } },
      select: { id: true, kind: true, subjectRefType: true, subjectRefId: true },
    }),
  );
  const goneIds = stillOpen
    .filter((f) => !seen.has(`${f.kind}|${f.subjectRefType}|${f.subjectRefId}`))
    .map((f) => f.id);

  let resolved = 0;
  for (const batch of chunk(goneIds, batchSize)) {
    await withTenant(tenantId, async (tx) => {
      const result = await tx.governFinding.updateMany({
        where: { id: { in: batch } },
        data: { status: 'resolved', resolvedAt: now, resolvedBySnapshotId: snapshotId },
      });
      resolved += result.count;
    });
  }

  return { opened, updated, resolved };
}

/**
 * The third resolver, for the one kind that has no snapshot.
 *
 * `audit_chain_broken` is raised by `verifyIncremental` (Task 10) and nothing
 * else. No snapshot build raises it and no snapshot build can show it gone, so
 * it is deliberately absent from the detect stage's `STANDING_KINDS` and cannot
 * be reached by `reconcileFindings` at all — which is the whole of C-a. For a
 * while both findings were raised under `coverage_gap`, a standing kind, and
 * the nightly build closed the audit integrity alarm every night with a
 * snapshot that had examined no audit events. C1's defect, at the two sites
 * C5's fix created.
 *
 * Closing them therefore has to happen HERE, from evidence a verification run
 * has and a snapshot build does not. `resolvedBySnapshotId` stays null and the
 * CHECK constraint exempts this kind by name (Task 1 Step 8); the row's
 * `resolvedAt` and the `AuditChainCheck` written in the same run are the
 * evidence, and `detail` is left exactly as it was raised so the finding still
 * says what went wrong when somebody reads it later.
 *
 * NEITHER FACT CAN FIRE IN THE RUN THAT RAISED THE FINDING IT CLOSES. That is
 * the property that makes this safe rather than a laundering step:
 *
 *  - `trustedCheckpointSequence` is the sequence of a head checkpoint that
 *    VERIFIED. A run that refused its checkpoint passes `null`, so the
 *    untrusted-checkpoint finding survives the run that raised it; it closes
 *    only once a later, verifiable checkpoint exists, which under Ruling G-12
 *    is what a clean genesis walk goes on to write. Only findings about
 *    STRICTLY EARLIER checkpoints are closed, so a checkpoint that is still the
 *    head keeps its finding.
 *  - `genesisWalkClean` means the chain was walked from sequence 1 and held. An
 *    incremental run that comes back clean has verified the segment AFTER a
 *    checkpoint and has said nothing whatever about the range before it, so it
 *    passes `false` and cannot close a break it never looked at.
 *
 * `accepted` is left alone, exactly as `reconcileFindings` leaves it.
 */
export async function resolveAuditIntegrityFindings(
  tenantId: string,
  evidence: { trustedCheckpointSequence: number | null; genesisWalkClean: boolean },
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ resolved: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? FINDING_BATCH;

  const open = await withTenant(tenantId, (tx) =>
    tx.governFinding.findMany({
      where: { kind: 'audit_chain_broken', status: { in: ['open', 'acknowledged'] } },
      select: { id: true, subjectRefId: true },
    }),
  );

  const closable = open.filter((finding) => {
    if (finding.subjectRefId.startsWith(AUDIT_CHECKPOINT_REF)) {
      if (evidence.trustedCheckpointSequence === null) return false;
      const sequence = Number(finding.subjectRefId.slice(AUDIT_CHECKPOINT_REF.length));
      // An unparseable reference closes nothing. Silently treating it as zero
      // would close every checkpoint finding the moment one row is malformed.
      return Number.isInteger(sequence) && sequence < evidence.trustedCheckpointSequence;
    }
    if (finding.subjectRefId.startsWith(AUDIT_CHAIN_REF)) return evidence.genesisWalkClean;
    return false;
  });

  let resolved = 0;
  for (const batch of chunk(closable.map((f) => f.id), batchSize)) {
    await withTenant(tenantId, async (tx) => {
      const result = await tx.governFinding.updateMany({
        where: { id: { in: batch } },
        // No `resolvedBySnapshotId`: there is no snapshot, and this is the one
        // kind the constraint exempts. Every other kind still names one.
        data: { status: 'resolved', resolvedAt: now },
      });
      resolved += result.count;
    });
  }

  return { resolved };
}

export async function assignFinding(
  tenantId: string,
  actorUserId: string | null,
  findingId: string,
  ownerPersonId: string,
  dueAt: Date,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.governFinding.update({
      where: { id: findingId },
      data: { ownerPersonId, dueAt, status: 'acknowledged' },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.finding.assign',
      targetType: 'GovernFinding',
      targetId: findingId,
      outcome: 'success',
      sourceIp: null,
      payload: { ownerPersonId, dueAt: dueAt.toISOString() },
    });
  });
}

/**
 * Acceptance requires a reason AND an expiry, and behaves like an SoD exception
 * in miniature: it lapses back to `open` and tells the owner. Acceptance with
 * no expiry is not representable, because a perpetual acceptance is a decision
 * nobody ever re-makes.
 */
export async function acceptFinding(
  tenantId: string,
  actorUserId: string | null,
  findingId: string,
  reason: string,
  until: Date,
  // Injectable, like every other clock in this codebase, and for the reason
  // `sweepAcceptedFindings` takes one two functions below: a domain function
  // that reads the wall clock cannot be tested deterministically. Written
  // against `Date.now()` this refused every fixture in Step 1 whose dates sit
  // in the past relative to the real clock -- so the suite passed only if it
  // was run before those dates and failed for ever afterwards, which is a test
  // that measures the calendar rather than the code.
  now: Date = new Date(),
): Promise<void> {
  if (reason.trim().length === 0) throw new Error('accepting a finding requires a reason');
  if (until.getTime() <= now.getTime()) {
    throw new Error('the acceptance expiry must be in the future; there is no perpetual acceptance');
  }

  await withTenant(tenantId, async (tx) => {
    await tx.governFinding.update({
      where: { id: findingId },
      data: { status: 'accepted', acceptedReason: reason, acceptedUntil: until },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.finding.accept',
      targetType: 'GovernFinding',
      targetId: findingId,
      outcome: 'success',
      sourceIp: null,
      payload: { reason, until: until.toISOString() },
    });
  });
}

/**
 * A finding somebody once formally accepted and then let quietly expire is a
 * different and worse thing than one nobody has looked at yet, so the severity
 * goes up one step and the finding says why.
 */
export async function sweepAcceptedFindings(
  tenantId: string,
  now: Date,
): Promise<{ lapsed: number }> {
  return withTenant(tenantId, async (tx) => {
    const lapsing = await tx.governFinding.findMany({
      where: { status: 'accepted', acceptedUntil: { lt: now } },
      select: { id: true, severity: true, detail: true },
    });

    for (const finding of lapsing) {
      await tx.governFinding.update({
        where: { id: finding.id },
        data: {
          status: 'open',
          severity: raiseSeverity(finding.severity as Severity),
          acceptedUntil: null,
          detail: {
            ...(finding.detail as Record<string, unknown>),
            lapsedAcceptanceAt: now.toISOString(),
          } as never,
        },
      });
      await recordEvent(tx, {
        actorUserId: null,
        action: 'govern.finding.acceptance_lapsed',
        targetType: 'GovernFinding',
        targetId: finding.id,
        outcome: 'success',
        sourceIp: null,
        payload: { raisedTo: raiseSeverity(finding.severity as Severity) },
      });
    }

    return { lapsed: lapsing.length };
  });
}

/**
 * Returns the new item's id, or NULL when one is already open for this source.
 *
 * Null rather than a throw, deliberately: a nightly snapshot re-observes the
 * same problem, and a P2002 on `remediation_item_one_open_per_finding` would
 * kill the whole detect stage over a row that is already being chased.
 */
export async function createRemediationItem(
  tx: TenantClient,
  tenantId: string,
  input: {
    kind: string;
    ownerPersonId: string;
    dueAt: Date;
    findingId?: string | null;
    campaignItemId?: string | null;
    description: string;
    deepLink: string;
  },
): Promise<string | null> {
  const existing = await tx.remediationItem.findFirst({
    where: {
      kind: input.kind,
      status: { in: ['open', 'in_progress'] },
      ...(input.findingId == null ? {} : { findingId: input.findingId }),
      ...(input.campaignItemId == null ? {} : { campaignItemId: input.campaignItemId }),
    },
    select: { id: true },
  });
  if (existing !== null) return null;

  const created = await tx.remediationItem.create({
    data: {
      tenantId,
      kind: input.kind,
      ownerPersonId: input.ownerPersonId,
      dueAt: input.dueAt,
      findingId: input.findingId ?? null,
      campaignItemId: input.campaignItemId ?? null,
      description: input.description,
      deepLink: input.deepLink,
    },
  });
  return created.id;
}

export async function resolveRemediationItem(
  tenantId: string,
  actorUserId: string | null,
  itemId: string,
  status: 'done' | 'wont_fix',
  comment: string,
): Promise<void> {
  if (comment.trim().length === 0) {
    throw new Error('closing a remediation item requires a comment saying what changed or why not');
  }
  await withTenant(tenantId, async (tx) => {
    await tx.remediationItem.update({
      where: { id: itemId },
      data: { status, resolutionComment: comment, resolvedByUserId: actorUserId, resolvedAt: new Date() },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.remediation.resolve',
      targetType: 'RemediationItem',
      targetId: itemId,
      outcome: 'success',
      sourceIp: null,
      payload: { status, comment },
    });
  });
}
