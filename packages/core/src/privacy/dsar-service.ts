import { createHash } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent, stableStringify } from '../audit/audit-service.js';
import { STEP_UP_MAX_AGE_MS } from '../auth/session-service.js';
import { requestExport, type ExportSummary } from '../exports/export-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { eraseSubject, erasureBlockers, type ErasureBlocker, type ErasureCounts } from './erasure.js';
import { collectSubjectData, countSubjectData, resolveSubjectIds, type SubjectIds, type SubjectSection } from './subject-data.js';

/**
 * Data-subject request (DSAR) cases (backlog #70).
 *
 * A case is opened for one person, with the reason, how the requester's
 * identity was verified, and a due date. Everything done under it is an
 * audit event whose target is the case, and that is the case's timeline:
 *
 *  - SEARCH: everything linked to the person, found through the data
 *    inventory's links (subject-data.ts). Reading it is audited.
 *  - ACCESS: the same data as a sealed, watermarked JSON bundle through the
 *    export service (kind `dsar_bundle`), never inline.
 *  - RECTIFICATION: through the ordinary edit routes, which accept the case id
 *    and record it (`assertRectificationCase`, `recordRectification`).
 *  - RESTRICTION: a flag on the person that provisioning, HR imports and
 *    directory sync honour -- visibly, naming the case.
 *  - ERASURE: refused while a legal hold, unresolved lifecycle work or live
 *    access applies; otherwise requested by one administrator and approved by
 *    a DIFFERENT one from a fresh session, which performs it in the same
 *    transaction that re-checks every blocker. The person is pseudonymised in
 *    place (erasure.ts), and the case keeps a receipt.
 */

export const PRIVACY_REQUEST_TYPES = ['access', 'rectification', 'restriction', 'erasure'] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];
export const PRIVACY_VERIFICATION_METHODS = ['in_person', 'known_channel', 'document', 'authenticated_session', 'other'] as const;
export type PrivacyVerificationMethod = (typeof PRIVACY_VERIFICATION_METHODS)[number];

/** One calendar month, the GDPR art. 12(3) default, rounded to 30 days. */
export const PRIVACY_CASE_DEFAULT_DUE_DAYS = 30;
/** Art. 12(3) allows extending by two further months. */
export const PRIVACY_CASE_MAX_DUE_DAYS = 90;
export const PRIVACY_TEXT_MIN_LENGTH = 10;
/** How old the approver's administrative session may be. The same rule as every step-up. */
export const PRIVACY_ERASURE_STEP_UP_MAX_AGE_MS = STEP_UP_MAX_AGE_MS;
/** Rows per table the console's search returns; counts are always complete. */
export const PRIVACY_SEARCH_ROWS_PER_TABLE = 25;
/** Erasing a person with a long history rewrites many rows. */
const ERASURE_TIMEOUT_MS = 2 * 60 * 1000;
const DAY_MS = 86_400_000;

export type PrivacyRefusalCode =
  | 'not-found'
  | 'person-not-found'
  | 'invalid'
  | 'case-closed'
  | 'wrong-person'
  | 'not-requested'
  | 'already-restricted'
  | 'not-restricted'
  | 'erased-permanently-restricted'
  | 'erasure-blocked'
  | 'erasure-pending'
  | 'not-pending'
  | 'four-eyes-required'
  | 'step-up-required';

export class PrivacyCaseRefusedError extends Error {
  constructor(
    readonly code: PrivacyRefusalCode,
    message: string,
    readonly blockers: ErasureBlocker[] = [],
  ) {
    super(message);
    this.name = 'PrivacyCaseRefusedError';
  }
}

const refuse = (code: PrivacyRefusalCode, message: string, blockers: ErasureBlocker[] = []): never => {
  throw new PrivacyCaseRefusedError(code, message, blockers);
};

export type PrivacyCaseRow = Awaited<ReturnType<TenantClient['privacyCase']['findFirstOrThrow']>>;

async function caseEvent(
  tx: TenantClient,
  caseId: string,
  actorUserId: string | null,
  action: string,
  payload: Record<string, unknown>,
  sourceIp: string | null = null,
  outcome: 'success' | 'failure' = 'success',
) {
  return recordEvent(tx, { actorUserId, action, targetType: 'PrivacyCase', targetId: caseId, outcome, sourceIp, payload });
}

/**
 * A refused act still leaves a record: the refused transaction rolled back,
 * so the refusal is written in a transaction of its own.
 */
async function withRefusalEvidence<T>(
  tenantId: string,
  caseId: string,
  action: string,
  actorUserId: string,
  sourceIp: string | null,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PrivacyCaseRefusedError && error.code !== 'not-found') {
      await withTenant(tenantId, (tx) =>
        caseEvent(tx, caseId, actorUserId, action, {
          refused: error.code,
          message: error.message,
          blockers: error.blockers.map((b) => ({ code: b.code, count: b.count })),
        }, sourceIp, 'failure'),
      );
    }
    throw error;
  }
}

async function loadCase(tx: TenantClient, caseId: string): Promise<PrivacyCaseRow> {
  const found = await tx.privacyCase.findFirst({ where: { id: caseId } });
  return found ?? refuse('not-found', 'Privacy case not found');
}

function assertOpen(row: PrivacyCaseRow): void {
  if (row.status !== 'open') refuse('case-closed', `Case ${row.reference} is closed`);
}

// ---- open, list, read ------------------------------------------------------

export interface OpenPrivacyCaseInput {
  actorUserId: string;
  personId: string;
  requestTypes: PrivacyRequestType[];
  reason: string;
  verificationMethod: PrivacyVerificationMethod;
  verificationAttestation: string;
  receivedAt?: Date | undefined;
  dueInDays?: number | undefined;
  sourceIp?: string | null | undefined;
}

export async function openPrivacyCase(tenantId: string, input: OpenPrivacyCaseInput, now: Date = new Date()): Promise<PrivacyCaseRow> {
  const types = [...new Set(input.requestTypes)];
  if (types.length === 0 || types.some((t) => !(PRIVACY_REQUEST_TYPES as readonly string[]).includes(t))) {
    refuse('invalid', `A case names one or more of: ${PRIVACY_REQUEST_TYPES.join(', ')}`);
  }
  if (!(PRIVACY_VERIFICATION_METHODS as readonly string[]).includes(input.verificationMethod)) {
    refuse('invalid', `Verification method must be one of: ${PRIVACY_VERIFICATION_METHODS.join(', ')}`);
  }
  if (input.reason.trim().length < PRIVACY_TEXT_MIN_LENGTH || input.verificationAttestation.trim().length < PRIVACY_TEXT_MIN_LENGTH) {
    refuse('invalid', `The reason and the identity-verification attestation each need at least ${PRIVACY_TEXT_MIN_LENGTH} characters`);
  }
  const dueInDays = input.dueInDays ?? PRIVACY_CASE_DEFAULT_DUE_DAYS;
  if (!Number.isInteger(dueInDays) || dueInDays < 1 || dueInDays > PRIVACY_CASE_MAX_DUE_DAYS) {
    refuse('invalid', `A case is due within 1 to ${PRIVACY_CASE_MAX_DUE_DAYS} days of receipt`);
  }
  const receivedAt = input.receivedAt ?? now;
  if (receivedAt.getTime() > now.getTime()) refuse('invalid', 'A request cannot be received in the future');
  const dueAt = new Date(receivedAt.getTime() + dueInDays * DAY_MS);

  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.findFirst({ where: { id: input.personId }, select: { id: true } });
    if (!person) refuse('person-not-found', 'Person not found');
    // Serialise reference allocation per tenant. Unique regardless (the
    // index), but two cases racing for DSAR-2026-0007 should not make one of
    // them fail.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`privacy-case:${tenantId}`}))`;
    const year = receivedAt.getUTCFullYear();
    const prefix = `DSAR-${year}-`;
    const sameYear = await tx.privacyCase.count({ where: { reference: { startsWith: prefix } } });
    const reference = `${prefix}${String(sameYear + 1).padStart(4, '0')}`;
    const created = await tx.privacyCase.create({
      data: {
        tenantId,
        personId: input.personId,
        reference,
        requestTypes: types,
        reason: input.reason.trim(),
        receivedAt,
        dueAt,
        verificationMethod: input.verificationMethod,
        verificationAttestation: input.verificationAttestation.trim(),
        verifiedByUserId: input.actorUserId,
        openedByUserId: input.actorUserId,
        openedAt: now,
      },
    });
    await caseEvent(tx, created.id, input.actorUserId, 'privacy.case.open', {
      reference,
      personId: input.personId,
      requestTypes: types,
      receivedAt: receivedAt.toISOString(),
      dueAt: dueAt.toISOString(),
      // The method, not the attestation text: the attestation can describe
      // the document the requester showed, and the case row is where it lives.
      verificationMethod: input.verificationMethod,
    }, input.sourceIp ?? null);
    return created;
  });
}

export interface PrivacyCaseListItem extends PrivacyCaseRow {
  personName: string;
  overdue: boolean;
}

function personName(person: { givenName: string; familyName: string }): string {
  return `${person.givenName} ${person.familyName}`.trim();
}

export async function listPrivacyCases(
  tx: TenantClient,
  options: { status?: 'open' | 'closed'; personId?: string; now?: Date } = {},
): Promise<PrivacyCaseListItem[]> {
  const now = options.now ?? new Date();
  const rows = await tx.privacyCase.findMany({
    where: {
      ...(options.status ? { status: options.status } : {}),
      ...(options.personId ? { personId: options.personId } : {}),
    },
    include: { person: { select: { givenName: true, familyName: true } } },
    orderBy: [{ status: 'desc' }, { dueAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  return rows.map(({ person, ...row }) => ({
    ...row,
    personName: personName(person),
    overdue: row.status === 'open' && row.dueAt.getTime() < now.getTime(),
  }));
}

export interface PrivacyCaseDetail {
  case: PrivacyCaseRow;
  person: {
    id: string;
    name: string;
    status: string;
    externalId: string | null;
    processingRestrictedAt: Date | null;
    processingRestrictedCaseId: string | null;
    erasedAt: Date | null;
    erasedCaseId: string | null;
  };
  overdue: boolean;
  /** Rows per linked table, for the "what we hold" summary. */
  holdings: Record<string, number>;
  erasureBlockers: ErasureBlocker[];
  timeline: {
    id: string;
    sequence: number;
    occurredAt: Date;
    actorUserId: string | null;
    action: string;
    outcome: string;
    targetType: string;
    targetId: string | null;
    payload: unknown;
  }[];
  actors: Record<string, string>;
}

export async function getPrivacyCase(tenantId: string, caseId: string, now: Date = new Date()): Promise<PrivacyCaseDetail> {
  return withTenant(tenantId, async (tx) => {
    const row = await loadCase(tx, caseId);
    const person = await tx.person.findUniqueOrThrow({ where: { id: row.personId } });
    const ids = (await resolveSubjectIds(tx, row.personId))!;
    const [holdings, blockers] = await Promise.all([countSubjectData(tx, ids), erasureBlockers(tx, ids)]);
    const caseEvents = await tx.auditEvent.findMany({
      where: { targetType: 'PrivacyCase', targetId: caseId },
      orderBy: { sequence: 'asc' },
    });
    // The export service's own events for the bundles this case asked for,
    // so "queued, ready, downloaded, expired" read as part of the case.
    const exportIds = [...new Set(caseEvents.flatMap((e) => {
      const id = (e.payload as Record<string, unknown> | null)?.exportId;
      return typeof id === 'string' ? [id] : [];
    }))];
    const exportEvents = exportIds.length === 0
      ? []
      : await tx.auditEvent.findMany({
        where: { targetType: 'DataExport', targetId: { in: exportIds } },
        orderBy: { sequence: 'asc' },
      });
    const timeline = [...caseEvents, ...exportEvents]
      .sort((a, b) => a.sequence - b.sequence)
      .map((e) => ({
        id: e.id,
        sequence: e.sequence,
        occurredAt: e.occurredAt,
        actorUserId: e.actorUserId,
        action: e.action,
        outcome: e.outcome,
        targetType: e.targetType,
        targetId: e.targetId,
        payload: e.payload,
      }));
    const actorIds = [...new Set([
      ...timeline.flatMap((e) => (e.actorUserId ? [e.actorUserId] : [])),
      row.openedByUserId,
      ...(row.erasureRequestedByUserId ? [row.erasureRequestedByUserId] : []),
      ...(row.erasureApprovedByUserId ? [row.erasureApprovedByUserId] : []),
    ])];
    const actorRows = await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } });
    return {
      case: row,
      person: {
        id: person.id,
        name: personName(person),
        status: person.status,
        externalId: person.externalId,
        processingRestrictedAt: person.processingRestrictedAt,
        processingRestrictedCaseId: person.processingRestrictedCaseId,
        erasedAt: person.erasedAt,
        erasedCaseId: person.erasedCaseId,
      },
      overdue: row.status === 'open' && row.dueAt.getTime() < now.getTime(),
      holdings,
      erasureBlockers: blockers,
      timeline,
      actors: Object.fromEntries(actorRows.map((u) => [u.id, u.displayName])),
    };
  });
}

// ---- search ----------------------------------------------------------------

export interface SubjectSearchResult {
  caseId: string;
  personId: string;
  ids: SubjectIds;
  sections: SubjectSection[];
}

/**
 * Everything linked to the case's person, a page of rows per table. Reading
 * everything about somebody is itself an act worth recording, so it is
 * audited with the counts it returned.
 */
export async function searchPrivacyCaseSubject(
  tenantId: string,
  caseId: string,
  actorUserId: string,
  sourceIp: string | null = null,
): Promise<SubjectSearchResult> {
  return withTenant(tenantId, async (tx) => {
    const row = await loadCase(tx, caseId);
    const ids = (await resolveSubjectIds(tx, row.personId))!;
    const sections = await collectSubjectData(tx, ids, { limitPerTable: PRIVACY_SEARCH_ROWS_PER_TABLE });
    await caseEvent(tx, caseId, actorUserId, 'privacy.case.search', {
      tables: Object.fromEntries(sections.map((s) => [s.table, s.count])),
    }, sourceIp);
    return { caseId, personId: row.personId, ids, sections };
  }, { timeoutMs: 60_000 });
}

// ---- access ----------------------------------------------------------------

/**
 * Queues the person's access bundle through the export service. The file is
 * generated by a background job, sealed, watermarked with the case, and
 * handed only to the administrator who asked for it.
 */
export async function requestPrivacyAccessBundle(
  scheduler: Scheduler,
  tenantId: string,
  caseId: string,
  input: { actorUserId: string; viaToken: boolean; ttlHours?: number | undefined; sourceIp: string | null },
): Promise<ExportSummary> {
  const row = await withTenant(tenantId, async (tx) => {
    const found = await loadCase(tx, caseId);
    assertOpen(found);
    return found;
  });
  const created = await requestExport(scheduler, tenantId, {
    kind: 'dsar_bundle',
    params: { caseId, personId: row.personId, reference: row.reference },
    ttlHours: input.ttlHours,
    requestedByUserId: input.actorUserId,
    requestedViaToken: input.viaToken,
    sourceIp: input.sourceIp,
  });
  await withTenant(tenantId, async (tx) => {
    await tx.privacyCase.update({ where: { id: caseId }, data: { accessExportId: created.id } });
    await caseEvent(tx, caseId, input.actorUserId, 'privacy.case.access_export', { exportId: created.id }, input.sourceIp);
  });
  return created;
}

// ---- rectification ---------------------------------------------------------

/**
 * Called by the ordinary edit routes when an edit names a case: the case must
 * be open and about this person. Rectification is never a separate write path;
 * it is the normal one with the case recorded.
 */
export async function assertRectificationCase(tx: TenantClient, caseId: string, personId: string): Promise<PrivacyCaseRow> {
  const row = await loadCase(tx, caseId);
  assertOpen(row);
  if (row.personId !== personId) refuse('wrong-person', `Case ${row.reference} is about a different person`);
  return row;
}

/** Records, on the case, which fields an edit under it changed. Never the values. */
export async function recordRectification(
  tx: TenantClient,
  caseId: string,
  input: { actorUserId: string; record: 'person' | 'contract'; recordId: string; fields: string[]; sourceIp: string | null },
): Promise<void> {
  await caseEvent(tx, caseId, input.actorUserId, 'privacy.case.rectify', {
    record: input.record,
    recordId: input.recordId,
    fields: [...input.fields].sort(),
  }, input.sourceIp);
}

// ---- restriction -----------------------------------------------------------

export async function restrictPersonProcessing(
  tenantId: string,
  caseId: string,
  input: { actorUserId: string; sourceIp: string | null },
  now: Date = new Date(),
): Promise<PrivacyCaseRow> {
  return withRefusalEvidence(tenantId, caseId, 'privacy.case.restrict', input.actorUserId, input.sourceIp, () =>
    withTenant(tenantId, async (tx) => {
      const row = await loadCase(tx, caseId);
      assertOpen(row);
      const person = await tx.person.findUniqueOrThrow({ where: { id: row.personId } });
      if (person.processingRestrictedAt !== null) {
        refuse('already-restricted', `Processing of this person is already restricted (case ${person.processingRestrictedCaseId})`);
      }
      await tx.person.update({
        where: { id: row.personId },
        data: { processingRestrictedAt: now, processingRestrictedCaseId: caseId },
      });
      await caseEvent(tx, caseId, input.actorUserId, 'privacy.case.restrict', { personId: row.personId }, input.sourceIp);
      await recordEvent(tx, {
        actorUserId: input.actorUserId, action: 'person.processing_restricted', targetType: 'Person', targetId: row.personId,
        outcome: 'success', sourceIp: input.sourceIp, payload: { caseId, reference: row.reference },
      });
      return row;
    }),
  );
}

export async function liftPersonRestriction(
  tenantId: string,
  caseId: string,
  input: { actorUserId: string; sourceIp: string | null },
): Promise<PrivacyCaseRow> {
  return withRefusalEvidence(tenantId, caseId, 'privacy.case.lift_restriction', input.actorUserId, input.sourceIp, () =>
    withTenant(tenantId, async (tx) => {
      const row = await loadCase(tx, caseId);
      assertOpen(row);
      const person = await tx.person.findUniqueOrThrow({ where: { id: row.personId } });
      if (person.erasedAt !== null) {
        refuse('erased-permanently-restricted', 'An erased person stays restricted, so a source that still holds them cannot write them back');
      }
      if (person.processingRestrictedAt === null) refuse('not-restricted', 'Processing of this person is not restricted');
      await tx.person.update({
        where: { id: row.personId },
        data: { processingRestrictedAt: null, processingRestrictedCaseId: null },
      });
      await caseEvent(tx, caseId, input.actorUserId, 'privacy.case.lift_restriction', {
        personId: row.personId, placedByCaseId: person.processingRestrictedCaseId,
      }, input.sourceIp);
      await recordEvent(tx, {
        actorUserId: input.actorUserId, action: 'person.processing_unrestricted', targetType: 'Person', targetId: row.personId,
        outcome: 'success', sourceIp: input.sourceIp, payload: { caseId, reference: row.reference },
      });
      return row;
    }),
  );
}

// ---- erasure ---------------------------------------------------------------

export async function requestPersonErasure(
  tenantId: string,
  caseId: string,
  input: { actorUserId: string; sourceIp: string | null },
  now: Date = new Date(),
): Promise<PrivacyCaseRow> {
  return withRefusalEvidence(tenantId, caseId, 'privacy.erasure.request', input.actorUserId, input.sourceIp, () =>
    withTenant(tenantId, async (tx) => {
      const row = await loadCase(tx, caseId);
      assertOpen(row);
      if (!row.requestTypes.includes('erasure')) {
        refuse('not-requested', 'This case does not record a request for erasure');
      }
      if (row.erasureStatus === 'pending_approval') refuse('erasure-pending', 'An erasure is already awaiting approval');
      const ids = (await resolveSubjectIds(tx, row.personId))!;
      const blockers = await erasureBlockers(tx, ids);
      if (blockers.length > 0) refuse('erasure-blocked', blockers.map((b) => b.message).join(' '), blockers);
      const pendingElsewhere = await tx.privacyCase.count({
        where: { personId: row.personId, erasureStatus: 'pending_approval' },
      });
      if (pendingElsewhere > 0) refuse('erasure-pending', 'Another case already has an erasure of this person awaiting approval');
      const updated = await tx.privacyCase.update({
        where: { id: caseId },
        data: {
          erasureStatus: 'pending_approval',
          erasureRequestedByUserId: input.actorUserId,
          erasureRequestedAt: now,
          erasureCancelledAt: null,
          erasureCancelledByUserId: null,
        },
      });
      await caseEvent(tx, caseId, input.actorUserId, 'privacy.erasure.request', {
        personId: row.personId,
        holdings: await countSubjectData(tx, ids),
      }, input.sourceIp);
      return updated;
    }),
  );
}

export async function cancelPersonErasure(
  tenantId: string,
  caseId: string,
  input: { actorUserId: string; sourceIp: string | null },
  now: Date = new Date(),
): Promise<PrivacyCaseRow> {
  return withTenant(tenantId, async (tx) => {
    const row = await loadCase(tx, caseId);
    if (row.erasureStatus !== 'pending_approval') refuse('not-pending', 'No erasure is awaiting approval on this case');
    // Stopping needs no second pair of eyes; the requester may cancel too.
    const { count } = await tx.privacyCase.updateMany({
      where: { id: caseId, erasureStatus: 'pending_approval' },
      data: { erasureStatus: 'cancelled', erasureCancelledByUserId: input.actorUserId, erasureCancelledAt: now },
    });
    if (count !== 1) refuse('not-pending', 'No erasure is awaiting approval on this case');
    await caseEvent(tx, caseId, input.actorUserId, 'privacy.erasure.cancel', {}, input.sourceIp);
    return tx.privacyCase.findUniqueOrThrow({ where: { id: caseId } });
  });
}

export interface ErasureReceipt {
  schema: 'syntra.erasure-receipt.v1';
  caseId: string;
  reference: string;
  personId: string;
  requestedByUserId: string;
  requestedAt: string;
  approvedByUserId: string;
  approvedAt: string;
  approverStepUpAt: string;
  completedAt: string;
  pseudonymized: Record<string, number>;
  deleted: Record<string, number>;
  retained: Record<string, number>;
  secretsDeleted: number;
  bundlesErased: number;
  /** SHA-256 over the receipt without this field, in stable key order. */
  digest: string;
}

/**
 * The second administrator's approval, which performs the erasure.
 *
 * Every check runs again here, inside the transaction that erases: a hold
 * placed, an account re-enabled or an operation queued since the request
 * refuses it. The database refuses an approver who is the requester whatever
 * this code does.
 */
export async function approvePersonErasure(
  tenantId: string,
  caseId: string,
  input: { actorUserId: string; stepUpAt: Date; sourceIp: string | null },
  now: Date = new Date(),
): Promise<{ case: PrivacyCaseRow; receipt: ErasureReceipt }> {
  return withRefusalEvidence(tenantId, caseId, 'privacy.erasure.approve', input.actorUserId, input.sourceIp, () =>
    withTenant(tenantId, async (tx) => {
      const row = await loadCase(tx, caseId);
      assertOpen(row);
      if (row.erasureStatus !== 'pending_approval') refuse('not-pending', 'No erasure is awaiting approval on this case');
      if (row.erasureRequestedByUserId === input.actorUserId) {
        refuse('four-eyes-required', 'A different administrator must approve an erasure');
      }
      const age = now.getTime() - input.stepUpAt.getTime();
      if (!(age >= 0 && age <= PRIVACY_ERASURE_STEP_UP_MAX_AGE_MS)) {
        refuse('step-up-required', 'Sign in to the console again to approve an erasure');
      }
      const ids = (await resolveSubjectIds(tx, row.personId))!;
      const blockers = await erasureBlockers(tx, ids);
      if (blockers.length > 0) refuse('erasure-blocked', blockers.map((b) => b.message).join(' '), blockers);

      // The approval, claimed conditionally first so two approvers racing
      // cannot both erase.
      const claimed = await tx.privacyCase.updateMany({
        where: { id: caseId, erasureStatus: 'pending_approval' },
        data: { erasureApprovedByUserId: input.actorUserId, erasureApprovedAt: now, erasureApproverStepUpAt: input.stepUpAt },
      });
      if (claimed.count !== 1) refuse('not-pending', 'No erasure is awaiting approval on this case');

      const counts: ErasureCounts = await eraseSubject(tx, ids, { caseId, actorUserId: input.actorUserId, now });
      const body = {
        schema: 'syntra.erasure-receipt.v1' as const,
        caseId,
        reference: row.reference,
        personId: row.personId,
        requestedByUserId: row.erasureRequestedByUserId!,
        requestedAt: row.erasureRequestedAt!.toISOString(),
        approvedByUserId: input.actorUserId,
        approvedAt: now.toISOString(),
        approverStepUpAt: input.stepUpAt.toISOString(),
        completedAt: now.toISOString(),
        ...counts,
      };
      const receipt: ErasureReceipt = { ...body, digest: createHash('sha256').update(stableStringify(body)).digest('hex') };
      const completed = await tx.privacyCase.update({
        where: { id: caseId },
        data: { erasureStatus: 'completed', erasureCompletedAt: now, erasureReceipt: receipt as never },
      });
      await caseEvent(tx, caseId, input.actorUserId, 'privacy.erasure.completed', { ...receipt }, input.sourceIp);
      await recordEvent(tx, {
        actorUserId: input.actorUserId, action: 'person.erased', targetType: 'Person', targetId: row.personId,
        outcome: 'success', sourceIp: input.sourceIp, payload: { caseId, reference: row.reference, digest: receipt.digest },
      });
      return { case: completed, receipt };
    }, { timeoutMs: ERASURE_TIMEOUT_MS }),
  );
}

// ---- close -----------------------------------------------------------------

export async function closePrivacyCase(
  tenantId: string,
  caseId: string,
  input: { actorUserId: string; note: string; sourceIp: string | null },
  now: Date = new Date(),
): Promise<PrivacyCaseRow> {
  return withTenant(tenantId, async (tx) => {
    const row = await loadCase(tx, caseId);
    assertOpen(row);
    if (row.erasureStatus === 'pending_approval') {
      refuse('erasure-pending', 'Approve or cancel the pending erasure before closing the case');
    }
    const closed = await tx.privacyCase.update({
      where: { id: caseId },
      data: { status: 'closed', closedAt: now, closedByUserId: input.actorUserId, closureNote: input.note.trim() || null },
    });
    await caseEvent(tx, caseId, input.actorUserId, 'privacy.case.close', {
      overdue: row.dueAt.getTime() < now.getTime(),
    }, input.sourceIp);
    return closed;
  });
}
