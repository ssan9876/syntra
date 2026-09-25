import { randomBytes } from 'node:crypto';
import { TENANT_DELETED_STATUS, withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { STEP_UP_MAX_AGE_MS } from '../auth/session-service.js';
import { computeTenantDataRevision, countOffboardingInventory } from './offboarding-service.js';

/**
 * Tenant deletion: request, four-eyes approval, cooling-off, execution.
 *
 * This is the one deliberate exception to "deactivate, never delete" that
 * removes a whole tenant (see docs/operate.md#tenant-deletion). Everything
 * else in the product deactivates because a deactivated row can be put back
 * and still tells you what happened. A tenant that is leaving is owed the
 * opposite: its data gone, and proof that it went. So the flow is built to
 * make the irreversible step hard to reach by accident and impossible to
 * reach on stale evidence:
 *
 *  - A request names the offboarding assessment and the export an
 *    administrator actually reviewed, by digest. Both must be current: the
 *    tenant's exportable data must hash to the same revision the assessment
 *    and export recorded, and the export must come after the assessment.
 *  - A DIFFERENT administrator approves, from a freshly stepped-up session,
 *    inside a bounded window. The database refuses an approver who is the
 *    requester, whatever the code above it does.
 *  - Execution waits out a cooling-off period, then re-runs every check --
 *    legal holds, unresolved lifecycle work, revision -- inside the same
 *    exclusive transaction that erases, so nothing can change between the
 *    last check and the first DELETE.
 */

export const TENANT_DELETION_APPROVAL_WINDOW_MS = 72 * 60 * 60 * 1000;
/**
 * The pause between approval and the earliest execution. Long enough for
 * somebody who did not know about the request -- the customer's own contact,
 * a colleague reading the audit feed -- to notice the approval and cancel,
 * and short enough that a genuine offboarding is not held up for a week.
 */
export const TENANT_DELETION_COOLING_OFF_MS = 24 * 60 * 60 * 1000;
/** After cooling off, how long the approval stays good for. */
export const TENANT_DELETION_EXECUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How old the administrative session behind an approval or an execution may
 * be. Elevation mints a new session, so its creation time is when the
 * administrator last proved who they were -- with a second factor wherever
 * the tenant requires one for administration.
 *
 * The same window every step-up action uses, so an administrator learns one
 * rule rather than one per destructive button.
 */
export const TENANT_DELETION_STEP_UP_MAX_AGE_MS = STEP_UP_MAX_AGE_MS;
export const TENANT_DELETION_REASON_MIN_LENGTH = 20;
/** Erasing a large tenant is many DELETEs; Prisma's 5 s default is not enough. */
const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What survives the erasure, and why.
 *
 *  - The `Tenant` row, as a tombstone: renamed, its hostnames released, its
 *    status `deleted`. It holds the id so it can never be reused and so the
 *    retained rows below still reference something.
 *  - `TenantDeletionRequest`: the completed request is the receipt. Every
 *    other request for the tenant is erased.
 *  - The audit record -- `AuditEvent`, `AuditCheckpoint`, `AuditChainCheck`,
 *    `AuditAnchor`. Audit events are immutable to the application
 *    (`audit_no_delete`), and the retention job already treats them that way:
 *    they leave only through the database-owner archive-and-prune procedure,
 *    at or before a verified checkpoint, once the audit retention period ends.
 *    Tenant deletion follows the same rule rather than inventing a second way
 *    to delete audit history -- an application path that can erase a tenant's
 *    audit log is exactly what an intruder with the application's credentials
 *    would want. The completion event is the final link in the tenant's chain.
 */
export const TENANT_DELETION_RETAINED_TABLES: readonly string[] = [
  'TenantDeletionRequest',
  'AuditEvent',
  'AuditCheckpoint',
  'AuditChainCheck',
  'AuditAnchor',
];

/**
 * Append-only evidence tables that ARE erased with the tenant.
 *
 * Their DELETE rules exist so no application code path can quietly rewrite a
 * single approval or review decision. They reference requests, people and
 * accounts, so keeping them would keep those too. The erasure disables the
 * rule inside its own transaction -- transactional DDL, rolled back with
 * everything else if anything fails -- deletes this tenant's rows, and
 * re-enables it before commit. Every decision was also written to the audit
 * log when it was made, and that is retained.
 *
 * The cost: ALTER TABLE takes an ACCESS EXCLUSIVE lock on these two tables
 * until the erasure commits, so every tenant's approval and review decisions
 * wait for it. Erasures are rare and short; that is documented rather than
 * engineered around.
 */
const APPEND_ONLY_ERASED: Record<string, string> = {
  ApprovalDecision: 'approval_decision_no_delete',
  CampaignDecision: 'govern_decision_no_delete',
};

export type TenantDeletionRefusalCode =
  | 'reason-required'
  | 'request-open'
  | 'not-found'
  | 'assessment-not-found'
  | 'assessment-not-ready'
  | 'assessment-stale'
  | 'export-not-found'
  | 'export-predates-assessment'
  | 'export-stale'
  | 'legal-hold-active'
  | 'lifecycle-work-unresolved'
  | 'four-eyes-required'
  | 'step-up-required'
  | 'not-pending'
  | 'not-approved'
  | 'approval-expired'
  | 'cooling-off'
  | 'execution-window-closed';

/** Refusals that end the request: it can never succeed as it stands. */
const CLOSING: Partial<Record<TenantDeletionRefusalCode, 'expired' | 'invalidated'>> = {
  'approval-expired': 'expired',
  'execution-window-closed': 'expired',
  'assessment-stale': 'invalidated',
  'export-stale': 'invalidated',
};

export class TenantDeletionRefusedError extends Error {
  constructor(readonly code: TenantDeletionRefusalCode, message: string) {
    super(message);
    this.name = 'TenantDeletionRefusedError';
  }
}

const refuse = (code: TenantDeletionRefusalCode, message: string): never => {
  throw new TenantDeletionRefusedError(code, message);
};

interface AuditRow { id: string; sequence: number; occurredAt: Date; payload: unknown }

function payloadOf(event: AuditRow): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

async function findEvidence(tx: TenantClient, action: string, digest: string): Promise<AuditRow | null> {
  return tx.auditEvent.findFirst({
    where: { action, payload: { path: ['digest'], equals: digest } },
    orderBy: { sequence: 'desc' },
    select: { id: true, sequence: true, occurredAt: true, payload: true },
  });
}

/** The inventory compared for staleness: everything but the audit count, which every step moves. */
function comparableInventory(inventory: Record<string, number>): Record<string, number> {
  const { auditEvents: _auditEvents, ...rest } = inventory;
  return rest;
}

function sameInventory(a: Record<string, number>, b: Record<string, number>): boolean {
  const left = comparableInventory(a);
  const right = comparableInventory(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

export interface DeletionPreflight {
  dataRevision: string;
  assessmentAuditEventId: string;
  exportAuditEventId: string;
}

/**
 * Every check a deletion must pass, recomputed from the database now.
 *
 * Blockers are checked first because they are the actionable ones: an
 * administrator told "legal hold CASE-7 is active" knows what to do, while
 * "stale" only tells them to reassess -- which would fail on the hold anyway.
 */
async function runPreflight(
  tx: TenantClient,
  tenantId: string,
  binding: { assessmentDigest: string; exportDigest: string; expectedRevision?: string },
): Promise<DeletionPreflight> {
  const { inventory, blockers } = await countOffboardingInventory(tx);
  if (blockers.activeLegalHolds > 0) {
    refuse('legal-hold-active', `${blockers.activeLegalHolds} active legal hold(s) must be released before this tenant can be deleted`);
  }
  if (blockers.unresolvedLifecycleOperations > 0) {
    refuse('lifecycle-work-unresolved', `${blockers.unresolvedLifecycleOperations} lifecycle operation(s) are unresolved; complete or cancel them first`);
  }

  const assessment = await findEvidence(tx, 'tenant.offboarding.assessed', binding.assessmentDigest);
  if (!assessment) return refuse('assessment-not-found', 'No offboarding assessment with that digest exists for this tenant');
  const assessed = payloadOf(assessment);
  if (assessed.deletionReady !== true) {
    refuse('assessment-not-ready', 'That assessment reported the tenant as not ready for deletion; resolve the blockers and assess again');
  }
  const current = await computeTenantDataRevision(tx, tenantId);
  if (typeof assessed.dataRevision !== 'string' || assessed.dataRevision !== current ||
      !sameInventory(assessed.inventory as Record<string, number>, inventory)) {
    refuse('assessment-stale', 'Tenant data has changed since that assessment; assess and export again');
  }

  const exported = await findEvidence(tx, 'tenant.offboarding.exported', binding.exportDigest);
  if (!exported) return refuse('export-not-found', 'No export with that digest exists for this tenant');
  if (exported.sequence <= assessment.sequence) {
    refuse('export-predates-assessment', 'The export must be taken after the assessment it accompanies');
  }
  if (payloadOf(exported).dataRevision !== current) {
    refuse('export-stale', 'Tenant data has changed since that export; export again');
  }
  if (binding.expectedRevision !== undefined && binding.expectedRevision !== current) {
    refuse('assessment-stale', 'Tenant data has changed since this deletion was requested');
  }
  return { dataRevision: current, assessmentAuditEventId: assessment.id, exportAuditEventId: exported.id };
}

function assertFreshStepUp(stepUpAt: Date, now: Date): void {
  const age = now.getTime() - stepUpAt.getTime();
  if (!(age >= 0 && age <= TENANT_DELETION_STEP_UP_MAX_AGE_MS)) {
    refuse('step-up-required', 'Sign in to the console again to confirm this deletion step');
  }
}

/** Marks an open request past its window as expired, and says so. */
async function expireIfLapsed(tx: TenantClient, request: { id: string; status: string; approvalExpiresAt: Date; executeBefore: Date | null }, now: Date) {
  const lapsed = (request.status === 'pending_approval' && request.approvalExpiresAt <= now) ||
    (request.status === 'approved' && request.executeBefore !== null && request.executeBefore <= now);
  if (!lapsed) return false;
  await tx.tenantDeletionRequest.update({
    where: { id: request.id },
    data: { status: 'expired', closedReason: request.status === 'pending_approval' ? 'approval-expired' : 'execution-window-closed' },
  });
  return true;
}

/**
 * Records a refusal in the audit log, in its own transaction, and closes the
 * request when the refusal means it can never succeed. The refused
 * transaction rolled back, so without this a failed attempt to erase a tenant
 * would leave no trace at all.
 */
async function recordRefusal(
  tenantId: string,
  action: string,
  actorUserId: string,
  requestId: string | null,
  error: TenantDeletionRefusedError,
  now: Date,
) {
  await withTenant(tenantId, async (tx) => {
    const closes = CLOSING[error.code];
    if (closes && requestId) {
      await tx.tenantDeletionRequest.updateMany({
        where: { id: requestId, status: { in: ['pending_approval', 'approved'] } },
        data: { status: closes, closedReason: error.code },
      });
    }
    await recordEvent(tx, {
      actorUserId, action, targetType: 'Tenant', targetId: tenantId, outcome: 'failure', sourceIp: null,
      payload: { requestId, code: error.code, reason: error.message, at: now.toISOString() },
    });
  }).catch(() => undefined);
}

async function withRefusalEvidence<T>(
  tenantId: string,
  action: string,
  actorUserId: string,
  requestId: string | null,
  now: Date,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TenantDeletionRefusedError) {
      await recordRefusal(tenantId, action, actorUserId, requestId, error, now);
    }
    throw error;
  }
}

export type TenantDeletionRequestRow = Awaited<ReturnType<TenantClient['tenantDeletionRequest']['findFirstOrThrow']>>;

/** The current or most recent request, with lapsed windows applied. */
export async function getTenantDeletionState(tenantId: string, now: Date = new Date()) {
  return withTenant(tenantId, async (tx) => {
    const latest = await tx.tenantDeletionRequest.findFirst({ orderBy: { requestedAt: 'desc' } });
    if (latest && await expireIfLapsed(tx, latest, now)) {
      return tx.tenantDeletionRequest.findUniqueOrThrow({ where: { id: latest.id } });
    }
    return latest;
  });
}

export async function requestTenantDeletion(
  tenantId: string,
  input: { actorUserId: string; assessmentDigest: string; exportDigest: string; reason: string },
  now: Date = new Date(),
): Promise<TenantDeletionRequestRow> {
  return withRefusalEvidence(tenantId, 'tenant.deletion.request_refused', input.actorUserId, null, now, () =>
    withTenant(tenantId, async (tx) => {
      const reason = input.reason.trim();
      if (reason.length < TENANT_DELETION_REASON_MIN_LENGTH) {
        refuse('reason-required', `Give a reason of at least ${TENANT_DELETION_REASON_MIN_LENGTH} characters`);
      }
      const open = await tx.tenantDeletionRequest.findFirst({ where: { status: { in: ['pending_approval', 'approved', 'executing'] } } });
      if (open && !(await expireIfLapsed(tx, open, now))) {
        refuse('request-open', 'A deletion request for this tenant is already open; cancel it first');
      }
      const preflight = await runPreflight(tx, tenantId, input);
      const created = await tx.tenantDeletionRequest.create({
        data: {
          tenantId,
          assessmentDigest: input.assessmentDigest,
          assessmentAuditEventId: preflight.assessmentAuditEventId,
          exportDigest: input.exportDigest,
          exportAuditEventId: preflight.exportAuditEventId,
          dataRevision: preflight.dataRevision,
          reason,
          requestedByUserId: input.actorUserId,
          requestedAt: now,
          approvalExpiresAt: new Date(now.getTime() + TENANT_DELETION_APPROVAL_WINDOW_MS),
        },
      });
      await recordEvent(tx, {
        actorUserId: input.actorUserId, action: 'tenant.deletion.requested', targetType: 'Tenant', targetId: tenantId,
        outcome: 'success', sourceIp: null,
        payload: {
          requestId: created.id, assessmentDigest: input.assessmentDigest, exportDigest: input.exportDigest,
          dataRevision: preflight.dataRevision, reason, approvalExpiresAt: created.approvalExpiresAt.toISOString(),
        },
      });
      return created;
    }));
}

export async function approveTenantDeletion(
  tenantId: string,
  requestId: string,
  input: { actorUserId: string; stepUpAt: Date },
  now: Date = new Date(),
): Promise<TenantDeletionRequestRow> {
  return withRefusalEvidence(tenantId, 'tenant.deletion.approve_refused', input.actorUserId, requestId, now, () =>
    withTenant(tenantId, async (tx) => {
      const request = await tx.tenantDeletionRequest.findFirst({ where: { id: requestId } });
      if (!request) return refuse('not-found', 'Deletion request not found');
      if (request.status === 'pending_approval' && request.approvalExpiresAt <= now) {
        refuse('approval-expired', 'This request was not approved in time; request deletion again');
      }
      if (request.status !== 'pending_approval') refuse('not-pending', `This request is ${request.status}, not awaiting approval`);
      if (request.requestedByUserId === input.actorUserId) {
        refuse('four-eyes-required', 'A different administrator must approve a deletion');
      }
      assertFreshStepUp(input.stepUpAt, now);
      await runPreflight(tx, tenantId, {
        assessmentDigest: request.assessmentDigest, exportDigest: request.exportDigest, expectedRevision: request.dataRevision,
      });
      const executeNotBefore = new Date(now.getTime() + TENANT_DELETION_COOLING_OFF_MS);
      const executeBefore = new Date(executeNotBefore.getTime() + TENANT_DELETION_EXECUTION_WINDOW_MS);
      // Conditional on the status read above, so two approvers racing cannot
      // both believe they approved.
      const { count } = await tx.tenantDeletionRequest.updateMany({
        where: { id: requestId, status: 'pending_approval' },
        data: {
          status: 'approved', approvedByUserId: input.actorUserId, approvedAt: now,
          approverStepUpAt: input.stepUpAt, executeNotBefore, executeBefore,
        },
      });
      if (count !== 1) refuse('not-pending', 'This request is no longer awaiting approval');
      await recordEvent(tx, {
        actorUserId: input.actorUserId, action: 'tenant.deletion.approved', targetType: 'Tenant', targetId: tenantId,
        outcome: 'success', sourceIp: null,
        payload: {
          requestId, requestedByUserId: request.requestedByUserId, stepUpAt: input.stepUpAt.toISOString(),
          executeNotBefore: executeNotBefore.toISOString(), executeBefore: executeBefore.toISOString(),
          dataRevision: request.dataRevision,
        },
      });
      return tx.tenantDeletionRequest.findUniqueOrThrow({ where: { id: requestId } });
    }));
}

export async function cancelTenantDeletion(
  tenantId: string,
  requestId: string,
  actorUserId: string,
  now: Date = new Date(),
): Promise<TenantDeletionRequestRow> {
  return withTenant(tenantId, async (tx) => {
    const request = await tx.tenantDeletionRequest.findFirst({ where: { id: requestId } });
    if (!request) return refuse('not-found', 'Deletion request not found');
    // Anyone who may request a deletion may stop one, the requester included:
    // stopping an irreversible act needs no second pair of eyes.
    const { count } = await tx.tenantDeletionRequest.updateMany({
      where: { id: requestId, status: { in: ['pending_approval', 'approved'] } },
      data: { status: 'cancelled', cancelledByUserId: actorUserId, cancelledAt: now, closedReason: 'cancelled' },
    });
    if (count !== 1) refuse('not-pending', `This request is ${request.status} and cannot be cancelled`);
    await recordEvent(tx, {
      actorUserId, action: 'tenant.deletion.cancelled', targetType: 'Tenant', targetId: tenantId,
      outcome: 'success', sourceIp: null, payload: { requestId, previousStatus: request.status },
    });
    return tx.tenantDeletionRequest.findUniqueOrThrow({ where: { id: requestId } });
  });
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Every tenant-scoped table, children before parents.
 *
 * Read from the catalog at execution time rather than listed here, so a table
 * added next month is erased without anybody remembering this file -- the
 * omission a hand-written list invites is precisely personal data surviving a
 * deletion that reported success. Fails closed on a foreign-key cycle rather
 * than guessing an order.
 */
async function erasureOrder(tx: TenantClient): Promise<string[]> {
  const tables = (await tx.$queryRaw<{ name: string }[]>`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  `).map((row) => row.name).filter((name) => !TENANT_DELETION_RETAINED_TABLES.includes(name));
  const edges = await tx.$queryRaw<{ child: string; parent: string }[]>`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint k
    JOIN pg_class child ON child.oid = k.conrelid
    JOIN pg_class parent ON parent.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE k.contype = 'f' AND n.nspname = 'public'
  `;
  const erasable = new Set(tables);
  // parent -> the erasable tables that reference it and must go first.
  const blockers = new Map<string, Set<string>>(tables.map((name) => [name, new Set<string>()]));
  for (const { child, parent } of edges) {
    if (child === parent || !erasable.has(child) || !erasable.has(parent)) continue;
    blockers.get(parent)!.add(child);
  }
  const order: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((name) => [...blockers.get(name)!].every((child) => !remaining.has(child))).sort();
    if (ready.length === 0) {
      throw new Error(`tenant erasure cannot order tables with a foreign-key cycle: ${[...remaining].sort().join(', ')}`);
    }
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
    }
  }
  for (const name of order) {
    if (!SAFE_IDENTIFIER.test(name)) throw new Error(`refusing to erase a table with an unexpected name: ${name}`);
  }
  return order;
}

/**
 * Cryptographic erasure of the tenant's vault.
 *
 * Each secret is sealed under its own data key, stored only wrapped under the
 * master key. Overwriting the wrapped key, its nonce and tag, and the
 * ciphertext with random bytes of the same length -- before the row is
 * deleted -- means the live database never again holds anything from which
 * the value can be recovered, whatever becomes of the dead tuple before
 * VACUUM reclaims it. It does not reach backups: a backup taken earlier still
 * holds the wrapped key, which is why docs/operate.md bounds the residual
 * exposure by backup expiry.
 */
async function eraseVault(tx: TenantClient): Promise<number> {
  const secrets = await tx.$queryRaw<{ id: string; c: number; i: number; t: number; w: number; di: number; dt: number }[]>`
    SELECT "id", octet_length("ciphertext") AS c, octet_length("iv") AS i, octet_length("tag") AS t,
           octet_length("wrappedDek") AS w, octet_length("dekIv") AS di, octet_length("dekTag") AS dt
    FROM "Secret"
  `;
  const noise = (length: number) => new Uint8Array(randomBytes(Math.max(1, length)));
  for (const secret of secrets) {
    await tx.secret.update({
      where: { id: secret.id },
      data: {
        ciphertext: noise(secret.c), iv: noise(secret.i), tag: noise(secret.t),
        wrappedDek: noise(secret.w), dekIv: noise(secret.di), dekTag: noise(secret.dt),
      },
    });
  }
  return secrets.length;
}

/**
 * Removes the tenant's background schedules and queued jobs, in the same
 * transaction as the erasure. pg-boss lives in its own schema, outside RLS,
 * and its rows name the tenant in their payload. A schedule left behind would
 * fire forever against a tombstone; `withTenant` refuses it, but the row --
 * and any person id in a queued job's payload -- would still be data about a
 * tenant that is supposed to be gone. Tolerates a database where pg-boss has
 * never started.
 */
async function eraseQueuedWork(tx: TenantClient, tenantId: string): Promise<{ schedules: number; jobs: number }> {
  const [present] = await tx.$queryRaw<{ schedule: boolean; job: boolean }[]>`
    SELECT to_regclass('pgboss.schedule') IS NOT NULL AS schedule, to_regclass('pgboss.job') IS NOT NULL AS job
  `;
  const schedules = present?.schedule
    ? await tx.$executeRaw`DELETE FROM pgboss.schedule WHERE data->>'tenantId' = ${tenantId}`
    : 0;
  const jobs = present?.job
    ? await tx.$executeRaw`DELETE FROM pgboss.job WHERE data->>'tenantId' = ${tenantId} AND state::text IN ('created', 'retry')`
    : 0;
  return { schedules, jobs };
}

export interface TenantDeletionReceipt {
  schema: 'syntra.tenant-deletion-receipt.v1';
  tenantId: string;
  requestId: string;
  assessmentDigest: string;
  exportDigest: string;
  dataRevision: string;
  requestedByUserId: string;
  requestedAt: string;
  approvedByUserId: string;
  approvedAt: string;
  executedByUserId: string;
  completedAt: string;
  secretsCryptoErased: number;
  schedulesRemoved: number;
  queuedJobsRemoved: number;
  rowsDeleted: Record<string, number>;
  retained: string[];
  completionAuditEvent: { id: string; sequence: number; hash: string };
}

export async function executeTenantDeletion(
  tenantId: string,
  requestId: string,
  input: { actorUserId: string; stepUpAt: Date },
  now: Date = new Date(),
): Promise<TenantDeletionReceipt> {
  return withRefusalEvidence(tenantId, 'tenant.deletion.execute_refused', input.actorUserId, requestId, now, () =>
    withTenant(tenantId, async (tx) => {
      // Bounded, so an erasure waiting on a lock it cannot get fails with a
      // clear error rather than holding the tenant's exclusive lock forever.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '30s'`);
      const request = await tx.tenantDeletionRequest.findFirst({ where: { id: requestId } });
      if (!request) return refuse('not-found', 'Deletion request not found');
      if (request.status !== 'approved' || !request.approvedByUserId || !request.approvedAt ||
          !request.executeNotBefore || !request.executeBefore) {
        return refuse('not-approved', `This request is ${request.status}; only an approved request can be executed`);
      }
      if (now < request.executeNotBefore) {
        refuse('cooling-off', `The cooling-off period ends at ${request.executeNotBefore.toISOString()}`);
      }
      if (now >= request.executeBefore) {
        refuse('execution-window-closed', 'The approval has lapsed; request deletion again');
      }
      assertFreshStepUp(input.stepUpAt, now);
      await runPreflight(tx, tenantId, {
        assessmentDigest: request.assessmentDigest, exportDigest: request.exportDigest, expectedRevision: request.dataRevision,
      });

      await tx.tenantDeletionRequest.update({
        where: { id: requestId },
        data: { status: 'executing', executedByUserId: input.actorUserId, executorStepUpAt: input.stepUpAt },
      });

      const secretsCryptoErased = await eraseVault(tx);
      const queued = await eraseQueuedWork(tx, tenantId);
      const rowsDeleted: Record<string, number> = {};
      const order = await erasureOrder(tx);
      // Disabled for the whole loop, not only around the table's own DELETE:
      // deleting a PARENT (an approval step, a campaign item) fires the
      // cascade into the append-only table, and the rule rewrites that
      // cascade into nothing, which Postgres reports as a broken foreign key
      // even when no child row exists. ALTER TABLE holds its lock until
      // commit either way, so a narrower window would buy nothing.
      for (const [table, rule] of Object.entries(APPEND_ONLY_ERASED)) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE RULE ${rule}`);
      }
      for (const table of order) {
        const count = await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1::uuid`, tenantId);
        if (count > 0) rowsDeleted[table] = count;
      }
      for (const [table, rule] of Object.entries(APPEND_ONLY_ERASED)) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE RULE ${rule}`);
      }
      const priorRequests = await tx.tenantDeletionRequest.deleteMany({ where: { id: { not: requestId } } });
      if (priorRequests.count > 0) rowsDeleted.TenantDeletionRequest = priorRequests.count;

      // The tombstone. Nothing here identifies the organisation: the name and
      // slug are replaced, hostnames released for reuse, branding dropped.
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          status: TENANT_DELETED_STATUS, name: 'Deleted tenant', slug: `deleted-${tenantId}`,
          primaryDomain: null, additionalDomains: [], brandName: null, brandLogo: null,
          brandPrimary: null, brandAccent: null, brandSupportUrl: null, brandSupportLabel: null,
        },
      });

      const retained = ['Tenant (tombstone)', ...TENANT_DELETION_RETAINED_TABLES];
      const counts = { secretsCryptoErased, schedulesRemoved: queued.schedules, queuedJobsRemoved: queued.jobs, rowsDeleted, retained };
      const event = await recordEvent(tx, {
        actorUserId: input.actorUserId, action: 'tenant.deletion.completed', targetType: 'Tenant', targetId: tenantId,
        outcome: 'success', sourceIp: null,
        payload: {
          requestId, assessmentDigest: request.assessmentDigest, exportDigest: request.exportDigest,
          dataRevision: request.dataRevision, requestedByUserId: request.requestedByUserId,
          approvedByUserId: request.approvedByUserId, executorStepUpAt: input.stepUpAt.toISOString(),
          completedAt: now.toISOString(), ...counts,
        },
      });
      const receipt: TenantDeletionReceipt = {
        schema: 'syntra.tenant-deletion-receipt.v1',
        tenantId,
        requestId,
        assessmentDigest: request.assessmentDigest,
        exportDigest: request.exportDigest,
        dataRevision: request.dataRevision,
        requestedByUserId: request.requestedByUserId,
        requestedAt: request.requestedAt.toISOString(),
        approvedByUserId: request.approvedByUserId,
        approvedAt: request.approvedAt.toISOString(),
        executedByUserId: input.actorUserId,
        completedAt: now.toISOString(),
        ...counts,
        completionAuditEvent: { id: event.id, sequence: event.sequence, hash: event.hash },
      };
      await tx.tenantDeletionRequest.update({
        where: { id: requestId },
        data: { status: 'completed', completedAt: now, reason: null, receipt: receipt as unknown as object },
      });
      return receipt;
    }, { exclusive: true, timeoutMs: EXECUTION_TIMEOUT_MS }));
}

/**
 * The retained receipt of a completed deletion. Reads through the tombstone,
 * which ordinary binding refuses; there is no route to it, because the tenant
 * no longer resolves -- it is for an operator answering "prove it went".
 */
export async function readTenantDeletionReceipt(tenantId: string): Promise<TenantDeletionReceipt | null> {
  return withTenant(tenantId, async (tx) => {
    const completed = await tx.tenantDeletionRequest.findFirst({ where: { status: 'completed' } });
    return (completed?.receipt ?? null) as TenantDeletionReceipt | null;
  }, { allowRetired: true });
}
