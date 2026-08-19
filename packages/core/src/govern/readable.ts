import type { TenantClient } from '@syntra/db';
import type { ClassifiedSource } from './freshness.js';

export class SnapshotNotReadableError extends Error {
  constructor(readonly reason: 'not_found' | 'building' | 'failed' | 'no_sources') {
    super(
      reason === 'not_found'
        ? 'no complete snapshot exists'
        : reason === 'building'
          ? 'this snapshot is still being built; a half-built snapshot is indistinguishable from a small organization'
          : reason === 'failed'
            ? 'this snapshot failed to build and describes nothing'
            : 'this snapshot recorded no source, so nothing in it has been shown to have been read',
    );
    this.name = 'SnapshotNotReadableError';
  }
}

export interface ReadableSnapshot {
  id: string;
  asOf: Date;
  status: 'complete';
  holdingCount: number;
  unattributableCount: number;
  coverageGapCount: number;
  unattributedAccountCount: number;
  personsWithActiveContract: number;
  sources: ClassifiedSource[];
}

/**
 * THE ONE ACCESSOR. Every report, every campaign, every export and every SoD
 * evaluation reads a snapshot through here and through nothing else.
 *
 * Govern trades Provision's whole-plan-in-one-transaction atomicity for a
 * status flag, and this function is the entire protection that trade bought.
 * Ruling G1 accepted the divergence on the condition that this test be made
 * load-bearing; `boundaries.test.ts` enumerates every route and asserts it.
 */
export async function readableSnapshot(
  tx: TenantClient,
  snapshotId?: string,
): Promise<ReadableSnapshot> {
  const row =
    snapshotId === undefined
      ? await tx.accessSnapshot.findFirst({
          where: { status: 'complete' },
          orderBy: { asOf: 'desc' },
        })
      : await tx.accessSnapshot.findUnique({ where: { id: snapshotId } });

  if (row === null) throw new SnapshotNotReadableError('not_found');
  if (row.status === 'building') throw new SnapshotNotReadableError('building');
  if (row.status !== 'complete') throw new SnapshotNotReadableError('failed');

  const sourceRows = await tx.snapshotSource.findMany({ where: { snapshotId: row.id } });
  if (sourceRows.length === 0) throw new SnapshotNotReadableError('no_sources');

  return {
    id: row.id,
    asOf: row.asOf,
    status: 'complete',
    holdingCount: row.holdingCount,
    unattributableCount: row.unattributableCount,
    coverageGapCount: row.coverageGapCount,
    unattributedAccountCount: row.unattributedAccountCount,
    personsWithActiveContract: row.personsWithActiveContract,
    sources: sourceRows.map((s) => ({
      sourceKind: s.sourceKind as ClassifiedSource['sourceKind'],
      sourceId: s.sourceId,
      sourceName: s.sourceName,
      lastRunId: s.lastRunId,
      lastSuccessfulReadAt: s.lastSuccessfulReadAt,
      lastAttemptedReadAt: s.lastAttemptedReadAt,
      completeness: s.completeness as ClassifiedSource['completeness'],
      staleness: s.staleness as ClassifiedSource['staleness'],
      freshnessSlaHours: s.freshnessSlaHours,
      gapCount: s.gapCount,
      ageHours:
        s.lastSuccessfulReadAt === null
          ? null
          : (row.asOf.getTime() - s.lastSuccessfulReadAt.getTime()) / 3_600_000,
    })),
  };
}

export interface SnapshotBracket {
  /** The most recent complete snapshot at or before the date. */
  before: { id: string; asOf: Date } | null;
  /** The first complete snapshot strictly after it. */
  after: { asOf: Date } | null;
}

/**
 * The two complete snapshots a date falls between.
 *
 * A LOCATOR, not a read: it returns ids and as-of times, never a snapshot's
 * contents, and the caller still goes through `readableSnapshot` for those.
 * It lives HERE rather than in `report-service.ts` because Ruling G-1's
 * boundary test forbids any other module from touching `accessSnapshot`
 * directly -- and rightly, since a `findFirst` there is one edit away from
 * becoming a read that skips the readability gate. Answering "which snapshot"
 * is this module's job; deciding what a gap between them means is the
 * caller's.
 */
export async function snapshotBracket(tx: TenantClient, date: Date): Promise<SnapshotBracket> {
  const before = await tx.accessSnapshot.findFirst({
    where: { status: 'complete', asOf: { lte: date } },
    orderBy: { asOf: 'desc' },
    select: { id: true, asOf: true },
  });
  const after = await tx.accessSnapshot.findFirst({
    where: { status: 'complete', asOf: { gt: date } },
    orderBy: { asOf: 'asc' },
    select: { asOf: true },
  });
  return { before, after };
}
