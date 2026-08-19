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
  const escape = (value: string) => (/["\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

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
];

export interface EvidenceBundle {
  header: ReportHeader;
  limitations: string[];
  snapshot: unknown;
  coverage: unknown;
  items: unknown[];
  decisions: unknown[];
  reviewers: unknown[];
  notifications: unknown[];
  dispatches: unknown[];
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

export async function createEvidencePack(
  tenantId: string,
  actorUserId: string,
  input: {
    kind: 'campaign' | 'report' | 'period';
    snapshotId?: string;
    campaignId?: string;
    scope: Record<string, unknown>;
  },
): Promise<{ id: string; digest: string; bundle: EvidenceBundle }> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const snapshot = await readableSnapshot(tx, input.snapshotId);
    const sources = await tx.snapshotSource.findMany({ where: { snapshotId: snapshot.id } });
    const gaps = await tx.coverageGap.findMany({ where: { snapshotId: snapshot.id } });
    const status = await integrityStatus(tx, false);
    const lastCheckpoint = await tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } });
    return { snapshot, sources, gaps, status, lastCheckpoint };
  });

  const from = (loaded.lastCheckpoint?.sequence ?? 0) + 1;
  const seed = loaded.lastCheckpoint?.hash ?? GENESIS_HASH;
  const segment = await verifySegment(tenantId, from, seed);

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
    scopeDescription: JSON.stringify(input.scope),
  };

  const withoutDigest: Omit<EvidenceBundle, 'digest'> = {
    header,
    // Printed on the COVER of every bundle, not kept in a caveats appendix,
    // because the harm this module causes is somebody over-reading its output.
    limitations: [...BUNDLE_LIMITATIONS],
    snapshot: {
      id: loaded.snapshot.id,
      asOf: loaded.snapshot.asOf.toISOString(),
      holdingCount: loaded.snapshot.holdingCount,
      unattributableCount: loaded.snapshot.unattributableCount,
    },
    coverage: loaded.gaps.map((g) => ({ kind: g.kind, reason: g.reason, systemId: g.systemId })),
    items: [],
    decisions: [],
    reviewers: [],
    notifications: [],
    dispatches: [],
    chain: {
      fromSequence: segment.fromSequence,
      toSequence: segment.toSequence,
      result: segment.result,
      headSequence: loaded.status.headSequence,
      headHash: loaded.status.headHash,
    },
  };

  const digest = bundleDigest(withoutDigest);
  const bundle: EvidenceBundle = { ...withoutDigest, digest };
  const body = JSON.stringify(bundle);

  const id = await withTenant(tenantId, async (tx) => {
    const pack = await tx.evidencePack.create({
      data: {
        tenantId,
        kind: input.kind,
        scope: input.scope as never,
        snapshotId: loaded.snapshot.id,
        campaignId: input.campaignId ?? null,
        chainHeadSequence: loaded.status.headSequence,
        chainHeadHash: loaded.status.headHash,
        chainVerificationResult: segment.result,
        chainFromSequence: segment.fromSequence,
        chainToSequence: segment.toSequence,
        digest,
        byteLength: Buffer.byteLength(body, 'utf8'),
        createdByUserId: actorUserId,
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'govern.evidence.create',
      targetType: 'EvidencePack',
      targetId: pack.id,
      outcome: 'success',
      sourceIp: null,
      payload: { kind: input.kind, digest, chainResult: segment.result, scope: input.scope },
    });
    return pack.id;
  });

  return { id, digest, bundle };
}
