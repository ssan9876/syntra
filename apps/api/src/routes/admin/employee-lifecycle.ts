import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma, type TenantClient } from '@syntra/db';
import { z } from 'zod';
import { idParam } from '@syntra/contracts';
import { PERMISSIONS, approvalDecision, approvalGateOpen, createLifecycleOperation, deactivateDirectoryUser, getLifecyclePolicy, type MasterKeyProvider, notifyLifecycleApprovers, overdueReason, queueTargetWork, recordEvent, sloMinutesFor, transitionLifecycleStep, TARGET_STEP_KEY, type Scheduler } from '@syntra/core';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { ProblemError } from '../../plugins/problem-json.js';
import { pageQuery } from './list-query.js';

export const endRequest = z.object({ reason: z.string().trim().min(1).max(1000), revision: z.string().length(64), urgent: z.boolean().default(false) }).strict();
const readPermissions = [PERMISSIONS.IDENTITY_READ, PERMISSIONS.DIRECTORY_READ, PERMISSIONS.PROVISION_READ];
const writePermissions = [...readPermissions, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.PROVISION_MANAGE];
export const employeeWorkQuery = pageQuery.extend({
  kind: z.enum(['onboarding', 'offboarding', 'failed']).optional(),
});

type EmployeeWorkRow = {
  id: string; kind: 'onboarding' | 'offboarding' | 'failed'; lifecycleKind: string | null;
  personId: string | null; personName: string; status: string; priority: string | null;
  overdue: boolean; overdueReason: string | null; approvalRequired: boolean; summary: string; updatedAt: Date;
  onboarding: bigint; offboarding: bigint; failed: bigint; total: bigint; filteredTotal: bigint;
};

/** The cross-source work queue is paged in PostgreSQL, not after an in-memory merge. */
async function listEmployeeWork(tx: TenantClient, query: z.infer<typeof employeeWorkQuery>) {
  const needle = query.q ? `%${query.q.toLocaleLowerCase()}%` : null;
  const kind = query.kind ?? null;
  const rows = await tx.$queryRaw<EmployeeWorkRow[]>(Prisma.sql`
    WITH items AS (
      SELECT 'lifecycle:' || o.id AS id,
        CASE WHEN o.status = 'failed' THEN 'failed' WHEN o.kind = 'offboard' THEN 'offboarding' ELSE 'onboarding' END AS kind,
        o.kind AS "lifecycleKind", o."personId", COALESCE(p."givenName" || ' ' || p."familyName", 'No employee assigned') AS "personName",
        o.status, o.priority, (o."dueAt" < now() AND o."acknowledgedAt" IS NULL) OR o."sloDeadlineAt" < now() AS overdue,
        CASE
          WHEN o."dueAt" < now() AND o."acknowledgedAt" IS NULL AND o."sloDeadlineAt" < now()
            THEN 'Work is overdue; service-level deadline breached'
          WHEN o."dueAt" < now() AND o."acknowledgedAt" IS NULL THEN 'Work is overdue'
          WHEN o."sloDeadlineAt" < now() THEN 'Service-level deadline breached'
          ELSE NULL
        END AS "overdueReason",
        o."approvalRequired" AND o."approvedAt" IS NULL AND o."rejectedAt" IS NULL AS "approvalRequired",
        CASE WHEN o.status = 'awaiting_approval' THEN o.kind || ' operation is waiting for a second person to approve it' ELSE o.kind || ' operation is ' || o.status END AS summary,
        o."updatedAt"
      FROM "LifecycleOperation" o LEFT JOIN "Person" p ON p.id = o."personId"
      WHERE o.status NOT IN ('completed', 'cancelled')
      UNION ALL
      SELECT 'provision:' || r.id, CASE WHEN r.status = 'failed' THEN 'failed' ELSE 'onboarding' END, NULL, r."personId",
        COALESCE(p."givenName" || ' ' || p."familyName", 'Unknown employee'), r.status, NULL, false, NULL, false,
        r."targetName" || ': ' || COALESCE(r.message, r.status), r."updatedAt"
      FROM (SELECT DISTINCT ON ("personId", "targetSystemId") * FROM "PersonProvisionReceipt" ORDER BY "personId", "targetSystemId", "updatedAt" DESC, id DESC) r
      LEFT JOIN "Person" p ON p.id = r."personId"
      WHERE r.status NOT IN ('applied', 'no_match') AND NOT EXISTS (SELECT 1 FROM "LifecycleOperation" o WHERE o.id = r."requestKey" AND o.status NOT IN ('completed', 'cancelled'))
      UNION ALL
      SELECT 'departure:' || p.id, 'offboarding', NULL, p.id, p."givenName" || ' ' || p."familyName", 'incomplete', NULL, false, NULL, false,
        (SELECT count(*) FROM "User" u WHERE u."personId" = p.id AND u.status = 'active') || ' active sign-ins and ' || (SELECT count(*) FROM "TargetAccount" a WHERE a."personId" = p.id AND a.status IN ('active','pending','conflict')) || ' unfinished target accounts', p."updatedAt"
      FROM "Person" p WHERE p.status = 'inactive' AND (EXISTS (SELECT 1 FROM "User" u WHERE u."personId" = p.id AND u.status = 'active') OR EXISTS (SELECT 1 FROM "TargetAccount" a WHERE a."personId" = p.id AND a.status IN ('active','pending','conflict')))
    ), counted AS (SELECT *, count(*) FILTER (WHERE kind = 'onboarding') OVER () AS onboarding, count(*) FILTER (WHERE kind = 'offboarding') OVER () AS offboarding, count(*) FILTER (WHERE kind = 'failed') OVER () AS failed, count(*) OVER () AS total FROM items)
    SELECT *, count(*) OVER () AS "filteredTotal" FROM counted WHERE (${kind}::text IS NULL OR kind = ${kind}) AND (${needle}::text IS NULL OR lower("personName" || ' ' || summary || ' ' || status || ' ' || kind || ' ' || COALESCE("lifecycleKind",'')) LIKE ${needle})
    ORDER BY "updatedAt" ASC, id ASC OFFSET ${(query.page - 1) * query.pageSize} LIMIT ${query.pageSize}`);
  const first = rows[0];
  return { items: rows.map(({ onboarding, offboarding, failed, total, filteredTotal, ...item }) => item), counts: { onboarding: Number(first?.onboarding ?? 0), offboarding: Number(first?.offboarding ?? 0), failed: Number(first?.failed ?? 0), total: Number(first?.total ?? 0) }, total: rows.length ? Number(first!.filteredTotal) : 0, page: query.page, pageSize: query.pageSize };
}

async function snapshot(tx: TenantClient, id: string) {
  const person = await tx.person.findUnique({ where: { id }, select: { id: true, givenName: true, familyName: true, status: true, departureOverride: true, updatedAt: true } });
  if (!person) throw new ProblemError(404, 'not-found', 'Person not found');
  const accounts = await tx.user.findMany({ where: { personId: id }, orderBy: { id: 'asc' }, select: {
    id: true, login: true, status: true, updatedAt: true,
    source: { select: { name: true, writebackEnabled: true, writebackDisable: true } },
  } });
  const targets = await tx.targetAccount.findMany({ where: { personId: id }, orderBy: { id: 'asc' }, select: {
    id: true, status: true, correlationKey: true, lastReconciledAt: true, disableDueAt: true, archiveDueAt: true,
    target: { select: { id: true, name: true, enabled: true, schedule: true, autoApply: true, disableGraceDays: true, entitlementRevocationDelayDays: true, archiveAfterDays: true } },
  } });
  const revision = createHash('sha256').update(JSON.stringify({ person, accounts, targets })).digest('hex');
  return { person, accounts, targets, revision };
}

export async function registerEmployeeLifecycleRoutes(app: FastifyInstance, options: { keyProvider: MasterKeyProvider; scheduler?: () => Scheduler | null; publicUrl?: string }) {
  app.addHook('preHandler', requireSession('admin'));
  const provider = options.keyProvider;
  app.get('/persons/:id/offboarding', { preHandler: readPermissions.map(requirePermission) }, async (request) => {
    const { id } = idParam.parse(request.params);
    return request.db(async (tx) => {
      const current = await snapshot(tx, id);
      const latestAttempt = await tx.auditEvent.findFirst({ where: { targetType: 'Person', targetId: id, action: { in: ['person.offboarding.started', 'person.offboarding.finished'] } }, orderBy: { sequence: 'desc' }, select: { occurredAt: true, action: true, payload: true } });
      return { ...current, latestAttempt };
    });
  });

  app.get('/employee-work', { preHandler: readPermissions.map(requirePermission) }, async (request) =>
    request.db(async (tx) => {
      const query = employeeWorkQuery.parse(request.query);
      return listEmployeeWork(tx, query);
      /* Legacy in-memory implementation retained below temporarily as a
       * reference while the raw-query result shape is covered by route tests.
       * The return above makes PostgreSQL own filtering and pagination. */
      const receiptHistory = await tx.personProvisionReceipt.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
      // A durable lifecycle operation is the queue item. Its receipts are
      // implementation detail for individual targets and must not create a
      // second, competing work item for the same employee.
      const lifecycleOperations = await tx.lifecycleOperation.findMany({
        where: { status: { notIn: ['completed', 'cancelled'] } },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      });
      const lifecycleRequestKeys = new Set(lifecycleOperations.map((operation) => operation.id));
      // One current row per employee and target. An older failed attempt is
      // resolved by a later successful retry and must not stay in the queue.
      const latestReceipts = new Map<string, (typeof receiptHistory)[number]>();
      for (const receipt of receiptHistory) {
        const key = `${receipt.personId}:${receipt.targetSystemId}`;
        if (!latestReceipts.has(key)) latestReceipts.set(key, receipt);
      }
      const receipts = [...latestReceipts.values()]
        .filter((receipt) => !lifecycleRequestKeys.has(receipt.requestKey))
        .filter((receipt) => !['applied', 'no_match'].includes(receipt.status))
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      const receiptPeople = await tx.person.findMany({
        where: { id: { in: [...new Set(receipts.map((item) => item.personId))] } },
        select: { id: true, givenName: true, familyName: true },
      });
      const names = new Map(receiptPeople.map((person) => [person.id, `${person.givenName} ${person.familyName}`]));
      const departures = await tx.person.findMany({
        where: {
          status: 'inactive',
        },
        select: {
          id: true,
          givenName: true,
          familyName: true,
          targetAccounts: { where: { status: { in: ['active', 'pending', 'conflict'] } }, select: { id: true } },
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      });
      const activeUsers = await tx.user.findMany({
        where: { personId: { in: departures.map((person) => person.id) }, status: 'active' },
        select: { id: true, personId: true },
      });
      const activeUserCounts = new Map<string, number>();
      for (const user of activeUsers) {
        const linkedPersonId = user.personId;
        if (typeof linkedPersonId !== 'string') continue;
        const personKey: string = linkedPersonId as string;
        activeUserCounts.set(personKey, (activeUserCounts.get(personKey) ?? 0) + 1);
      }
      const provisioning = receipts.map((receipt) => ({
        id: `provision:${receipt.id}`,
        kind: receipt.status === 'failed' ? 'failed' : 'onboarding',
        personId: receipt.personId,
        personName: names.get(receipt.personId) ?? 'Unknown employee',
        status: receipt.status,
        summary: `${receipt.targetName}: ${receipt.message ?? receipt.status}`,
        updatedAt: receipt.updatedAt,
      }));
      const lifecyclePeople = await tx.person.findMany({
        where: { id: { in: [...new Set(lifecycleOperations.flatMap((operation) => operation.personId ? [operation.personId] : []))] } },
        select: { id: true, givenName: true, familyName: true },
      });
      const lifecycleNames = new Map(lifecyclePeople.map((person) => [person.id, `${person.givenName} ${person.familyName}`]));
      const now = new Date();
      const lifecycle = lifecycleOperations.map((operation) => ({
        id: `lifecycle:${operation.id}`,
        kind: operation.status === 'failed' ? 'failed' : operation.kind === 'offboard' ? 'offboarding' : 'onboarding',
        lifecycleKind: operation.kind,
        personId: operation.personId,
        personName: operation.personId ? lifecycleNames.get(operation.personId) ?? 'Unknown employee' : 'No employee assigned',
        status: operation.status,
        priority: operation.priority,
        overdue: overdueReason(operation, now) !== null,
        overdueReason: overdueReason(operation, now),
        approvalRequired: operation.approvalRequired && operation.approvedAt === null && operation.rejectedAt === null,
        summary: operation.status === 'awaiting_approval'
          ? `${operation.kind} operation is waiting for a second person to approve it${operation.approvalReason ? `: ${operation.approvalReason}` : ''}`
          : `${operation.kind} operation is ${operation.status}${overdueReason(operation, now) ? ` — ${overdueReason(operation, now)}` : ''}`,
        updatedAt: operation.updatedAt,
      }));
      const offboarding = departures.filter((person) => (activeUserCounts.get(person.id) ?? 0) > 0 || person.targetAccounts.length > 0).map((person) => ({
        id: `departure:${person.id}`,
        kind: 'offboarding',
        personId: person.id,
        personName: `${person.givenName} ${person.familyName}`,
        status: 'incomplete',
        summary: `${activeUserCounts.get(person.id) ?? 0} active sign-in${(activeUserCounts.get(person.id) ?? 0) === 1 ? '' : 's'} and ${person.targetAccounts.length} unfinished target account${person.targetAccounts.length === 1 ? '' : 's'}`,
        updatedAt: person.updatedAt,
      }));
      const allItems = [...offboarding, ...provisioning, ...lifecycle].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      const needle = query.q?.toLocaleLowerCase();
      const matching = allItems.filter((item) =>
        (!query.kind || item.kind === query.kind) &&
        (!needle || [item.personName, item.summary, item.status, item.kind, 'lifecycleKind' in item ? item.lifecycleKind : '']
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle)),
      );
      const start = (query.page - 1) * query.pageSize;
      return {
        counts: {
          onboarding: allItems.filter((item) => item.kind === 'onboarding').length,
          offboarding: offboarding.length,
          failed: allItems.filter((item) => item.kind === 'failed').length,
          total: allItems.length,
        },
        items: matching.slice(start, start + query.pageSize),
        total: matching.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    }),
  );

  app.post('/persons/:id/offboarding', { preHandler: writePermissions.map(requirePermission) }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { reason, revision, urgent } = endRequest.parse(request.body);
    const attemptId = randomUUID();
    const policy = await getLifecyclePolicy(request.tenantId);
    const priority = urgent ? 'critical' : 'normal';
    const before = await request.db(async (tx) => {
      // Serialize confirmation and persist the start before making external writes.
      await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await snapshot(tx, id);
      if (current.revision !== revision) throw new ProblemError(409, 'preview-stale', 'The employee changed', 'Refresh the offboarding preview before continuing.');
      if (current.accounts.some((a) => a.id === request.session.userId)) throw new ProblemError(409, 'self-offboarding', 'Another administrator must end your employment');
      const departure = current.person.departureOverride ?? new Date();
      await tx.person.update({ where: { id }, data: { status: 'inactive', departureOverride: departure, departureOverrideBy: request.session.userId, departureOverrideNote: reason } });
      await recordEvent(tx, { actorUserId: request.session.userId, action: 'person.offboarding.started', targetType: 'Person', targetId: id, outcome: 'success', sourceIp: request.ip, payload: { attemptId, reason, departure: departure.toISOString(), accountIds: current.accounts.map((a) => a.id), targetIds: current.targets.map((a) => a.target.id) } });
      return { ...current, departure };
    });
    const operation = await createLifecycleOperation({
      tenantId: request.tenantId,
      personId: id,
      kind: 'offboard',
      idempotencyKey: attemptId,
      input: {
        reason,
        departure: before.departure.toISOString(),
        accountIds: before.accounts.map((account) => account.id),
        targetIds: before.targets.map((account) => account.target.id),
      },
      // These are independent safety branches. Target revocation must not be
      // withheld because an upstream directory write-back failed.
      steps: [
        { key: 'local-access', title: 'Disable Syntra sign-ins and sessions', required: true },
        { key: TARGET_STEP_KEY, title: 'Revoke and verify target access', required: true },
      ],
      requestedByUserId: request.session.userId,
      priority,
      sloMinutes: sloMinutesFor(policy, 'offboard', priority),
      // Sign-in is blocked immediately whatever policy says about approval:
      // the gate only holds the target writes, never the local access block.
      approval: approvalDecision(policy, { kind: 'offboard', priority, createsAccount: false, entitlementChanges: [] }),
    });
    const results: { userId: string; login: string; status: string; message: string }[] = [];
    for (const account of before.accounts) {
      try {
        const stillLinked = await request.db((tx) => tx.user.findFirst({ where: { id: account.id, personId: id } }));
        if (!stillLinked) { results.push({ userId: account.id, login: account.login, status: 'failed', message: 'Account linkage changed. Refresh before retrying.' }); continue; }
        const result = await deactivateDirectoryUser(request.tenantId, provider, { userId: account.id, reason, actorUserId: request.session.userId, sourceIp: request.ip, scheduler: null });
        results.push({ userId: account.id, login: account.login, status: result.ok ? 'disabled' : 'failed', message: result.ok ? 'Sign-in disabled; Syntra sessions and refresh tokens revoked.' : result.reason === 'writeback_not_enabled' ? 'Enable directory disable write-back or disable this account in its source directory.' : result.reason === 'no_credential' ? 'The source directory has no usable credential.' : 'The directory operation failed. Review account activity and retry.' });
      } catch (err) {
        request.log.error({ err, personId: id, userId: account.id }, 'employee offboarding account failed');
        results.push({ userId: account.id, login: account.login, status: 'failed', message: 'Account state could not be confirmed. Refresh and retry.' });
      }
    }
    await transitionLifecycleStep(
      request.tenantId,
      operation.id,
      'local-access',
      results.some((result) => result.status === 'failed') ? 'failed' : 'succeeded',
      { evidence: { results } },
    );
    // Directory write-back also sets a departure. Preserve the original policy
    // clock so retrying a partially completed departure cannot extend retention.
    let provisionMessage: string | null = null;
    const targetIds = [...new Set(before.targets.map((account) => account.target.id))];
    if (targetIds.length > 0 && !approvalGateOpen(operation)) {
      provisionMessage = 'Policy requires a second person to approve the target work for an urgent departure. Sign-in is already blocked.';
      await notifyLifecycleApprovers(request.tenantId, operation, request.session.userId, options.publicUrl ? { publicUrl: options.publicUrl } : {});
    } else if (targetIds.length > 0) {
      const scheduler = options.scheduler?.();
      if (!scheduler) {
        provisionMessage = 'Background jobs are unavailable. Target work remains in the employee queue.';
        await transitionLifecycleStep(request.tenantId, operation.id, TARGET_STEP_KEY, 'failed', {
          allowOutOfOrder: true,
          message: provisionMessage,
          responseCategory: 'unavailable',
        });
      } else {
        try {
          // Independent of the local step's outcome: target revocation must
          // not be withheld because an upstream directory write-back failed.
          const current = await request.db((tx) => tx.lifecycleStep.findFirst({ where: { operationId: operation.id, key: 'local-access' }, select: { status: true } }));
          if (current?.status === 'failed') {
            await transitionLifecycleStep(request.tenantId, operation.id, TARGET_STEP_KEY, 'running', { allowOutOfOrder: true });
          }
          await queueTargetWork(request.tenantId, operation.id, id, scheduler, targetIds);
        } catch (err) {
          request.log.error({ err, personId: id, attemptId }, 'employee offboarding provisioning could not be queued');
          provisionMessage = 'Target work could not be queued. Retry it from the employee record.';
          await transitionLifecycleStep(request.tenantId, operation.id, TARGET_STEP_KEY, 'failed', {
            allowOutOfOrder: true,
            message: provisionMessage,
            responseCategory: 'unavailable',
          });
        }
      }
    } else {
      await transitionLifecycleStep(request.tenantId, operation.id, TARGET_STEP_KEY, 'skipped', {
        message: 'No managed target account needs access removal.',
        responseCategory: 'no_change_required',
      });
    }
    await request.db(async (tx) => {
      await tx.person.update({ where: { id }, data: { departureOverride: before.departure } });
      await recordEvent(tx, { actorUserId: request.session.userId, action: 'person.offboarding.finished', targetType: 'Person', targetId: id, outcome: results.some((r) => r.status === 'failed') || provisionMessage ? 'failure' : 'success', sourceIp: request.ip, payload: { attemptId, reason, results, targetWorkPending: before.targets.length > 0, provisionMessage } });
    });
    const final = await request.db((tx) => tx.lifecycleOperation.findFirstOrThrow({ where: { id: operation.id } }));
    return { attemptId, operationId: operation.id, results, targetWorkPending: before.targets.length > 0, provisionMessage, priority, sloDeadlineAt: final.sloDeadlineAt, approvalRequired: final.approvalRequired, approvalReason: final.approvalReason };
  });
}
