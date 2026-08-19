import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { FINDING_BATCH, reconcileFindings, type FindingDraft } from './finding-service.js';
import type { FindingKind } from './types.js';

export interface DriftRow {
  id: string;
  kind: string;
  targetSystemId: string;
  accountId: string | null;
  entitlementId: string | null;
  subjectAnchor: string | null;
  status: string;
}

/**
 * The whole policy, in one object. Two entries.
 *
 * `missing_grant` is deliberately absent: Govern's holding table records what
 * IS held, so a grant Syntra believes it made that the target does not have
 * produces no Govern holding and therefore no Govern finding to link.
 * `account_missing_at_target` and `unexpected_status` are statements about an
 * account's existence or state at the target, which Govern does not model as a
 * finding of its own. Naming the absences here is the point: an omission with
 * no reason beside it is the thing a later reader closes in the wrong
 * direction.
 */
export const DRIFT_LINKABLE: Readonly<Record<'orphan_account' | 'unattributable_holding', string>> = {
  orphan_account: 'orphan_account',
  unattributable_holding: 'unmanaged_entitlement',
};

/** NFKD, not NFD, and lower-cased: AD folds case and PostgreSQL does not. */
const fold = (value: string) => value.normalize('NFKD').toLowerCase();

/**
 * Pure. Given Govern's drafts and Provision's OPEN drift rows, returns the same
 * drafts with `driftFindingId` set where the two describe one problem.
 *
 * It never drops a draft and never invents one. A Govern finding that matches
 * nothing in Provision is still Govern's to raise — most of them are, because
 * Provision only sees targets — and the link is an AGGREGATION, never a copy.
 */
export function linkDrafts(
  drafts: readonly FindingDraft[],
  drift: readonly DriftRow[],
  accountIdByAnchor: ReadonlyMap<string, string>,
): FindingDraft[] {
  const open = drift.filter((d) => d.status === 'open' || d.status === 'acknowledged');

  const byOrphanKey = new Map<string, string>();
  const byEntitlementKey = new Map<string, string>();
  for (const row of open) {
    if (row.kind === DRIFT_LINKABLE.orphan_account && row.subjectAnchor !== null) {
      byOrphanKey.set(`${row.targetSystemId}|${fold(row.subjectAnchor)}`, row.id);
    }
    if (
      row.kind === DRIFT_LINKABLE.unattributable_holding &&
      row.accountId !== null &&
      row.entitlementId !== null
    ) {
      byEntitlementKey.set(`${row.targetSystemId}|${row.accountId}|${row.entitlementId}`, row.id);
    }
  }

  return drafts.map((draft) => {
    const detail = draft.detail;
    const systemId = typeof detail['systemId'] === 'string' ? detail['systemId'] : null;
    const accountRef = typeof detail['accountRef'] === 'string' ? detail['accountRef'] : null;

    if (draft.kind === 'orphan_account' && systemId !== null && accountRef !== null) {
      const id = byOrphanKey.get(`${systemId}|${fold(accountRef)}`);
      return id === undefined ? draft : { ...draft, driftFindingId: id };
    }

    if (
      draft.kind === 'unattributable_holding' &&
      detail['resourceKind'] === 'targetEntitlement' &&
      systemId !== null &&
      accountRef !== null &&
      typeof detail['resourceId'] === 'string'
    ) {
      const accountId = accountIdByAnchor.get(`${systemId}|${fold(accountRef)}`);
      if (accountId === undefined) return draft;
      const id = byEntitlementKey.get(`${systemId}|${accountId}|${detail['resourceId']}`);
      return id === undefined ? draft : { ...draft, driftFindingId: id };
    }

    return draft;
  });
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `reconcileFindings` with the drift link on both ends.
 *
 * Before: every draft is matched against Provision's open drift rows, so one
 * underlying problem produces one row in each dashboard with a reference
 * between them rather than two independent lifecycles.
 *
 * After: every Govern finding this call moved to `resolved` that carried a
 * `driftFindingId` closes the Provision row behind it. `accepted` findings are
 * NOT propagated — acceptance is a human tolerating a live problem with an
 * expiry on the toleration, and telling the other dashboard it went away would
 * be false.
 *
 * Every read here is a short transaction returning plain data and every write
 * is batched at FINDING_BATCH. Nothing holds a transaction across a loop.
 */
export async function reconcileLinkedFindings(
  tenantId: string,
  snapshotId: string,
  kinds: readonly FindingKind[],
  drafts: readonly FindingDraft[],
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ opened: number; updated: number; resolved: number; linked: number; driftClosed: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? FINDING_BATCH;

  const driftRows = await withTenant(tenantId, (tx) =>
    tx.driftFinding.findMany({
      where: { status: { in: ['open', 'acknowledged'] } },
      select: {
        id: true, kind: true, targetSystemId: true, accountId: true,
        entitlementId: true, subjectAnchor: true, status: true,
      },
    }),
  );
  const accounts = await withTenant(tenantId, (tx) =>
    tx.targetAccount.findMany({
      where: { anchor: { not: null } },
      select: { id: true, targetSystemId: true, anchor: true },
    }),
  );
  const accountIdByAnchor = new Map(
    accounts.map((a) => [`${a.targetSystemId}|${fold(a.anchor!)}`, a.id]),
  );

  const linkedDrafts = linkDrafts(drafts, driftRows, accountIdByAnchor);
  const linked = linkedDrafts.filter((d) => (d.driftFindingId ?? null) !== null).length;

  // Which linked findings were open BEFORE the reconcile, so the ones that are
  // `resolved` after it are exactly the ones this call closed. `reconcileFindings`
  // returns counts and not ids, and a count cannot say which Provision row to close.
  const before = await withTenant(tenantId, (tx) =>
    tx.governFinding.findMany({
      where: {
        status: { in: ['open', 'acknowledged'] },
        kind: { in: [...kinds] },
        driftFindingId: { not: null },
      },
      select: { id: true, driftFindingId: true },
    }),
  );

  const { opened, updated, resolved } = await reconcileFindings(
    tenantId, snapshotId, kinds, linkedDrafts, options,
  );

  let driftClosed = 0;
  if (before.length > 0) {
    const nowResolved = await withTenant(tenantId, (tx) =>
      tx.governFinding.findMany({
        where: { id: { in: before.map((f) => f.id) }, status: 'resolved' },
        select: { id: true, driftFindingId: true },
      }),
    );
    const driftIds = [...new Set(nowResolved.map((f) => f.driftFindingId).filter((id): id is string => id !== null))];
    for (const batch of chunk(driftIds, batchSize)) {
      await withTenant(tenantId, async (tx) => {
        const result = await tx.driftFinding.updateMany({
          where: { id: { in: batch }, status: { in: ['open', 'acknowledged'] } },
          data: { status: 'resolved', lastSeenAt: now },
        });
        driftClosed += result.count;
        if (result.count > 0) {
          await recordEvent(tx, {
            actorUserId: null,
            action: 'govern.finding.drift_closed',
            targetType: 'DriftFinding',
            targetId: batch[0]!,
            outcome: 'success',
            sourceIp: null,
            payload: { count: result.count, snapshotId, driftFindingIds: batch },
          });
        }
      });
    }
  }

  return { opened, updated, resolved, linked, driftClosed };
}

/**
 * The other direction. Provision resolved the drift — a run removed the
 * unmanaged entitlement, an administrator linked the orphan — so the Govern
 * finding that references it is resolved too, with the reason recorded in
 * words rather than as a bare status change nobody can account for later.
 *
 * `accepted` is left alone here as well, and for the same reason.
 */
export async function adoptDriftClosures(
  tenantId: string,
  snapshotId: string,
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ adopted: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? FINDING_BATCH;

  const candidates = await withTenant(tenantId, (tx) =>
    tx.governFinding.findMany({
      where: { status: { in: ['open', 'acknowledged'] }, driftFindingId: { not: null } },
      select: { id: true, driftFindingId: true, detail: true },
    }),
  );
  if (candidates.length === 0) return { adopted: 0 };

  const driftIds = candidates
    .map((c) => c.driftFindingId)
    .filter((id): id is string => id !== null);

  const closedDrift = await withTenant(tenantId, (tx) =>
    tx.driftFinding.findMany({
      where: { id: { in: driftIds }, status: 'resolved' },
      select: { id: true },
    }),
  );
  const closedIds = new Set(closedDrift.map((d) => d.id));
  const toAdopt = candidates.filter((c) => c.driftFindingId !== null && closedIds.has(c.driftFindingId));

  let adopted = 0;
  for (const batch of chunk(toAdopt, batchSize)) {
    await withTenant(tenantId, async (tx) => {
      for (const finding of batch) {
        await tx.governFinding.update({
          where: { id: finding.id },
          data: {
            status: 'resolved',
            resolvedAt: now,
            resolvedBySnapshotId: snapshotId,
            detail: {
              ...(finding.detail as Record<string, unknown>),
              resolvedBecause:
                'Provision resolved the DriftFinding this aggregates; there is one problem underneath and it is closed',
              resolvedDriftFindingId: finding.driftFindingId,
            } as never,
          },
        });
        adopted += 1;
      }
    });
  }

  return { adopted };
}
