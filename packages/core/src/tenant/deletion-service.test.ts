import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, TenantRetiredError, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { verifyChain } from '../audit/audit-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { getSecret, putSecret } from '../vault/vault-service.js';
import { assessTenantOffboarding, createTenantDataExport } from './offboarding-service.js';
import {
  TENANT_DELETION_APPROVAL_WINDOW_MS,
  TENANT_DELETION_COOLING_OFF_MS,
  TENANT_DELETION_RETAINED_TABLES,
  TENANT_DELETION_STEP_UP_MAX_AGE_MS,
  TenantDeletionRefusedError,
  approveTenantDeletion,
  cancelTenantDeletion,
  executeTenantDeletion,
  getTenantDeletionState,
  readTenantDeletionReceipt,
  requestTenantDeletion,
} from './deletion-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const HOUR = 60 * 60 * 1000;
const REASON = 'Customer contract ended; signed offboarding form OFF-2291';

let tenantId: string;
let otherTenantId: string;
let requesterId: string;
let approverId: string;
let otherPersonId: string;

async function seedTenant(id: string, prefix: string) {
  return withTenant(id, async (tx) => {
    const owner = await tx.user.create({ data: { tenantId: id, login: `${prefix}-owner`, email: `${prefix}-owner@${prefix}.test`, displayName: `${prefix} Owner` } });
    const second = await tx.user.create({ data: { tenantId: id, login: `${prefix}-second`, email: `${prefix}-second@${prefix}.test`, displayName: `${prefix} Second` } });
    const person = await tx.person.create({ data: { tenantId: id, givenName: 'Ada', familyName: `Lovelace-${prefix}`, personalEmail: `ada@${prefix}-home.test` } });
    await tx.contract.create({ data: { tenantId: id, personId: person.id, startDate: new Date('2026-01-01'), sequence: 1 } });
    const group = await tx.group.create({ data: { tenantId: id, name: `${prefix} engineers` } });
    await tx.groupMembership.create({ data: { tenantId: id, groupId: group.id, userId: owner.id } });
    await putSecret(tx, provider, 'connector.password', `${prefix}-hunter2`);
    const operation = await tx.lifecycleOperation.create({
      data: { tenantId: id, kind: 'move', idempotencyKey: `${prefix}-done`, status: 'completed', inputFingerprint: 'x', input: {} },
    });
    await tx.lifecycleLegalHold.create({
      data: { tenantId: id, subjectType: 'lifecycle_operation', subjectId: operation.id, reference: 'OLD-1', reason: 'Released hold', placedByUserId: owner.id, releasedAt: new Date(), releasedByUserId: owner.id },
    });
    // An append-only approval decision: erasure has to get past its rule.
    const request = await tx.accessRequest.create({
      data: { tenantId: id, subjectPersonId: person.id, requestedByUserId: owner.id, requestedByPersonId: person.id, origin: 'catalog', status: 'approved', submittedAt: new Date(), decidedAt: new Date() },
    });
    const step = await tx.approvalStep.create({
      data: { tenantId: id, requestId: request.id, sequence: 1, stageSnapshot: { selector: 'manager' }, status: 'approved', closedAt: new Date() },
    });
    await tx.approvalDecision.create({ data: { tenantId: id, stepId: step.id, personId: person.id, decision: 'approve', via: 'selector' } });
    return { owner: owner.id, second: second.id, person: person.id, operation: operation.id };
  });
}

/** Every table with a `tenantId`, with this tenant's row count, read through RLS. */
async function tenantRowCounts(id: string): Promise<Record<string, number>> {
  return withTenant(id, async (tx) => {
    const tables = await tx.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1
    `;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${name}" WHERE "tenantId" = $1::uuid`, id);
      counts[name] = Number(row!.n);
    }
    return counts;
  }, { allowRetired: true, timeoutMs: 60_000 });
}

async function readyEvidence() {
  const assessment = await assessTenantOffboarding(tenantId, requesterId);
  const exported = await createTenantDataExport(tenantId, requesterId);
  return { assessmentDigest: assessment.digest, exportDigest: exported.digest };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(TenantDeletionRefusedError);
  return (error as TenantDeletionRefusedError).code;
}

async function approvedRequest(t0: Date) {
  const evidence = await readyEvidence();
  const request = await requestTenantDeletion(tenantId, { actorUserId: requesterId, ...evidence, reason: REASON }, t0);
  const approvedAt = new Date(t0.getTime() + HOUR);
  await approveTenantDeletion(tenantId, request.id, { actorUserId: approverId, stepUpAt: new Date(approvedAt.getTime() - 60_000) }, approvedAt);
  const executeAt = new Date(approvedAt.getTime() + TENANT_DELETION_COOLING_OFF_MS + HOUR);
  return { request, evidence, executeAt, stepUpAt: new Date(executeAt.getTime() - 60_000) };
}

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme Holdings', slug: 'acme', primaryDomain: 'acme.example' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Globex', slug: 'globex' } })).id;
  const acme = await seedTenant(tenantId, 'acme');
  requesterId = acme.owner;
  approverId = acme.second;
  const globex = await seedTenant(otherTenantId, 'globex');
  otherPersonId = globex.person;
  // An ACTIVE hold in the other tenant. It must not block this tenant's
  // erasure: the preflight counts holds through RLS, not across tenants.
  await withTenant(otherTenantId, (tx) => tx.lifecycleLegalHold.create({
    data: { tenantId: otherTenantId, subjectType: 'lifecycle_operation', subjectId: globex.operation, reference: 'GLOBEX-LIT', reason: 'Litigation', placedByUserId: globex.owner },
  }));
});

describe('tenant deletion execution', () => {
  it('erases every tenant row except the tombstone and the retained record, leaving another tenant untouched', async () => {
    const t0 = new Date();
    const { request, evidence, executeAt, stepUpAt } = await approvedRequest(t0);
    const otherBefore = await tenantRowCounts(otherTenantId);

    const receipt = await executeTenantDeletion(tenantId, request.id, { actorUserId: requesterId, stepUpAt }, executeAt);

    // Nothing left but what the design retains, by name.
    const after = await tenantRowCounts(tenantId);
    const survivors = Object.entries(after).filter(([, n]) => n > 0).map(([name]) => name).sort();
    expect(survivors.every((name) => TENANT_DELETION_RETAINED_TABLES.includes(name))).toBe(true);
    expect(after.TenantDeletionRequest).toBe(1);
    expect(after.Person).toBe(0);
    expect(after.User).toBe(0);
    expect(after.Secret).toBe(0);
    expect(after.ApprovalDecision).toBe(0);

    // The other tenant, row for row, and its vault still opens.
    expect(await tenantRowCounts(otherTenantId)).toEqual(otherBefore);
    expect(await withTenant(otherTenantId, (tx) => getSecret(tx, provider, 'connector.password'))).toBe('globex-hunter2');
    expect(await withTenant(otherTenantId, (tx) => tx.person.count({ where: { id: otherPersonId } }))).toBe(1);

    // The tombstone identifies nothing and no longer resolves.
    const tombstone = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tombstone).toMatchObject({ status: 'deleted', name: 'Deleted tenant', slug: `deleted-${tenantId}`, primaryDomain: null });
    await expect(withTenant(tenantId, (tx) => tx.user.count())).rejects.toBeInstanceOf(TenantRetiredError);

    // The receipt: digests, actors, timestamps, counts -- and no personal data.
    expect(receipt).toMatchObject({
      tenantId, requestId: request.id, ...evidence, requestedByUserId: requesterId, approvedByUserId: approverId,
      executedByUserId: requesterId, secretsCryptoErased: 1,
    });
    expect(receipt.rowsDeleted).toMatchObject({ Person: 1, User: 2, Secret: 1, ApprovalDecision: 1 });
    const serialised = JSON.stringify(await readTenantDeletionReceipt(tenantId));
    for (const personal of ['Lovelace', 'ada@', 'acme-owner', 'Acme Holdings', 'acme.example', 'OFF-2291', 'hunter2']) {
      expect(serialised).not.toContain(personal);
    }
    const stored = await withTenant(tenantId, (tx) => tx.tenantDeletionRequest.findUniqueOrThrow({ where: { id: request.id } }), { allowRetired: true });
    expect(stored).toMatchObject({ status: 'completed', reason: null });

    // The retained audit chain still verifies and ends with the completion.
    const chain = await withTenant(tenantId, async (tx) => ({
      result: await verifyChain(tx),
      last: await tx.auditEvent.findFirstOrThrow({ orderBy: { sequence: 'desc' } }),
    }), { allowRetired: true });
    expect(chain.result).toEqual({ valid: true });
    expect(chain.last).toMatchObject({ action: 'tenant.deletion.completed', id: receipt.completionAuditEvent.id });
  });

});

describe('tenant deletion refusals', () => {
  it('refuses a short reason, an unknown assessment, and an export taken before the assessment', async () => {
    const exported = await createTenantDataExport(tenantId, requesterId);
    const assessment = await assessTenantOffboarding(tenantId, requesterId);
    expect(await refusal(requestTenantDeletion(tenantId, { actorUserId: requesterId, assessmentDigest: assessment.digest, exportDigest: exported.digest, reason: 'too short' }))).toBe('reason-required');
    expect(await refusal(requestTenantDeletion(tenantId, { actorUserId: requesterId, assessmentDigest: 'a'.repeat(64), exportDigest: exported.digest, reason: REASON }))).toBe('assessment-not-found');
    expect(await refusal(requestTenantDeletion(tenantId, { actorUserId: requesterId, assessmentDigest: assessment.digest, exportDigest: exported.digest, reason: REASON }))).toBe('export-predates-assessment');
    // Each refusal is evidence in its own right.
    const refused = await withTenant(tenantId, (tx) => tx.auditEvent.count({ where: { action: 'tenant.deletion.request_refused', outcome: 'failure' } }));
    expect(refused).toBe(3);
  });

  it('refuses a stale assessment when tenant data changed after it was taken', async () => {
    const evidence = await readyEvidence();
    await withTenant(tenantId, (tx) => tx.person.updateMany({ data: { givenName: 'Augusta' } }));
    expect(await refusal(requestTenantDeletion(tenantId, { actorUserId: requesterId, ...evidence, reason: REASON }))).toBe('assessment-stale');
  });

  it('refuses while a legal hold is active or lifecycle work is unresolved', async () => {
    const evidence = await readyEvidence();
    const hold = await withTenant(tenantId, async (tx) => {
      const operation = await tx.lifecycleOperation.findFirstOrThrow();
      return tx.lifecycleLegalHold.create({
        data: { tenantId, subjectType: 'lifecycle_operation', subjectId: operation.id, reference: 'CASE-7', reason: 'Litigation', placedByUserId: requesterId },
      });
    });
    expect(await refusal(requestTenantDeletion(tenantId, { actorUserId: requesterId, ...evidence, reason: REASON }))).toBe('legal-hold-active');
    await withTenant(tenantId, (tx) => tx.lifecycleLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date() } }));
    await withTenant(tenantId, (tx) => tx.lifecycleOperation.create({
      data: { tenantId, kind: 'move', idempotencyKey: 'open', status: 'running', inputFingerprint: 'y', input: {} },
    }));
    expect(await refusal(requestTenantDeletion(tenantId, { actorUserId: requesterId, ...evidence, reason: REASON }))).toBe('lifecycle-work-unresolved');
  });

  it('allows only one open request', async () => {
    const evidence = await readyEvidence();
    await requestTenantDeletion(tenantId, { actorUserId: requesterId, ...evidence, reason: REASON });
    expect(await refusal(requestTenantDeletion(tenantId, { actorUserId: approverId, ...evidence, reason: REASON }))).toBe('request-open');
  });
});

describe('tenant deletion approval', () => {
  it('requires a different administrator with a fresh step-up', async () => {
    const t0 = new Date();
    const request = await requestTenantDeletion(tenantId, { actorUserId: requesterId, ...(await readyEvidence()), reason: REASON }, t0);
    const later = new Date(t0.getTime() + HOUR);
    expect(await refusal(approveTenantDeletion(tenantId, request.id, { actorUserId: requesterId, stepUpAt: later }, later))).toBe('four-eyes-required');
    const staleStepUp = new Date(later.getTime() - TENANT_DELETION_STEP_UP_MAX_AGE_MS - 1000);
    expect(await refusal(approveTenantDeletion(tenantId, request.id, { actorUserId: approverId, stepUpAt: staleStepUp }, later))).toBe('step-up-required');

    const approved = await approveTenantDeletion(tenantId, request.id, { actorUserId: approverId, stepUpAt: later }, later);
    expect(approved).toMatchObject({ status: 'approved', approvedByUserId: approverId });
    expect(approved.executeNotBefore!.getTime()).toBe(later.getTime() + TENANT_DELETION_COOLING_OFF_MS);
  });

  it('enforces four eyes in the database as well', async () => {
    const request = await requestTenantDeletion(tenantId, { actorUserId: requesterId, ...(await readyEvidence()), reason: REASON });
    const now = new Date();
    await expect(withTenant(tenantId, (tx) => tx.tenantDeletionRequest.update({
      where: { id: request.id },
      data: { status: 'approved', approvedByUserId: requesterId, approvedAt: now, approverStepUpAt: now, executeNotBefore: now, executeBefore: new Date(now.getTime() + HOUR) },
    }))).rejects.toThrow(/four_eyes/);
  });

  it('expires a request that is not approved in time', async () => {
    const t0 = new Date();
    const request = await requestTenantDeletion(tenantId, { actorUserId: requesterId, ...(await readyEvidence()), reason: REASON }, t0);
    const late = new Date(t0.getTime() + TENANT_DELETION_APPROVAL_WINDOW_MS + 1000);
    expect(await refusal(approveTenantDeletion(tenantId, request.id, { actorUserId: approverId, stepUpAt: late }, late))).toBe('approval-expired');
    expect(await getTenantDeletionState(tenantId, late)).toMatchObject({ status: 'expired', closedReason: 'approval-expired' });
  });
});

describe('tenant deletion execution checks', () => {
  it('waits out the cooling-off period', async () => {
    const t0 = new Date();
    const { request } = await approvedRequest(t0);
    const early = new Date(t0.getTime() + 2 * HOUR);
    expect(await refusal(executeTenantDeletion(tenantId, request.id, { actorUserId: requesterId, stepUpAt: early }, early))).toBe('cooling-off');
    expect((await getTenantDeletionState(tenantId, early))?.status).toBe('approved');
  });

  it('re-checks staleness at execution and invalidates the request, erasing nothing', async () => {
    const { request, executeAt, stepUpAt } = await approvedRequest(new Date());
    await withTenant(tenantId, (tx) => tx.group.updateMany({ data: { description: 'changed after approval' } }));
    const before = await tenantRowCounts(tenantId);

    expect(await refusal(executeTenantDeletion(tenantId, request.id, { actorUserId: requesterId, stepUpAt }, executeAt))).toBe('assessment-stale');

    const after = await tenantRowCounts(tenantId);
    expect(after.Person).toBe(before.Person);
    expect(after.Secret).toBe(1);
    expect(await getTenantDeletionState(tenantId, executeAt)).toMatchObject({ status: 'invalidated', closedReason: 'assessment-stale' });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe('active');
  });

  it('re-checks legal holds at execution', async () => {
    const { request, executeAt, stepUpAt } = await approvedRequest(new Date());
    await withTenant(tenantId, async (tx) => {
      const operation = await tx.lifecycleOperation.findFirstOrThrow();
      await tx.lifecycleLegalHold.create({
        data: { tenantId, subjectType: 'lifecycle_operation', subjectId: operation.id, reference: 'LATE-HOLD', reason: 'Regulator enquiry', placedByUserId: approverId },
      });
    });
    expect(await refusal(executeTenantDeletion(tenantId, request.id, { actorUserId: requesterId, stepUpAt }, executeAt))).toBe('legal-hold-active');
    expect(await withTenant(tenantId, (tx) => tx.person.count())).toBe(1);
  });

  it('cannot execute a cancelled request', async () => {
    const { request, executeAt, stepUpAt } = await approvedRequest(new Date());
    await cancelTenantDeletion(tenantId, request.id, requesterId);
    expect(await refusal(executeTenantDeletion(tenantId, request.id, { actorUserId: requesterId, stepUpAt }, executeAt))).toBe('not-approved');
    expect(await withTenant(tenantId, (tx) => tx.auditEvent.count({ where: { action: 'tenant.deletion.cancelled' } }))).toBe(1);
  });
});
