import { prisma, TENANT_DELETED_STATUS, withTenant } from '@syntra/db';
import { WEBHOOK_MAX_ATTEMPTS } from '../notify/webhook-retry.js';
import type { JobHealthCount } from '../jobs/job-health.js';

/**
 * What one scrape reports about the installation.
 *
 * Every field is INSTALLATION-WIDE, never per tenant, and that is a decision
 * rather than an omission: a per-tenant series would let anybody who can scrape
 * enumerate customers, count them and read their slugs, and cardinality would
 * grow with the customer list — the ordinary way a Prometheus instance is
 * brought down by its own success. An operator debugging one tenant has the
 * audit log and the console, both authenticated and both better at it.
 *
 * `null` is used where "we do not know" is different from zero. A deployment
 * whose scheduler has never started has no job table to count, and reporting
 * `0` there would read as "the queue is empty" on a dashboard when the truth
 * is "nothing is processing the queue at all".
 */
export interface MetricsSnapshot {
  webhookDeliveriesPending: number;
  webhookDeliveriesAbandoned: number;
  logoutDeliveriesPending: number;
  logoutDeliveriesAbandoned: number;
  sessionsActive: number;
  usersActive: number;
  usersInactive: number;
  accountsLocked: number;
  lifecycleOperationsUnresolved: number;
  lifecycleOperationsFailed: number;
  lifecycleOperationsOverdue: number;
  lifecycleOperationsAwaitingApproval: number;
  lifecycleOperationsSloBreached: number;
  /** Age of the oldest unresolved lifecycle operation, installation-wide. Null when none. */
  lifecycleOldestUnresolvedAgeSeconds: number | null;
  /** Receipts stepping back from a saturated tenant right now. */
  lifecycleReceiptsDeferred: number;
  /** Fraction of lifecycle operations resolved in the last day that needed more than one attempt. Null when none resolved. */
  lifecycleRetryRate: number | null;
  /** Provisioning actions that exhausted their retries and wait for the next run: the dead-letter equivalent. */
  provisionActionsPendingRetry: number;
  provisionActionsFailed24h: number;
  provisionRunsFailed24h: number;
  /** Enabled, scheduled targets whose last run is older than a day, or that never ran. */
  targetsStale: number;
  /** Age of the OLDEST current readiness check across targets. Null when no target has one. */
  readinessFreshnessSeconds: number | null;
  /** Completed-operation duration quantiles over the last day, by kind. */
  lifecycleOperationDurationSeconds: { kind: string; quantile: string; seconds: number }[];
  /** Applied-receipt duration quantiles over the last day, by target TYPE (never by target id). */
  targetOperationDurationSeconds: { targetType: string; quantile: string; seconds: number }[];
  /** Null when pg-boss has never created its schema in this database. */
  jobsPending: number | null;
  /** Null when no signing key exists yet. */
  signingKeyExpiresInSeconds: number | null;
  /**
   * Queue-health findings by kind and finding (backlog #57), across every
   * tenant. Every (kind, finding) pair is present, zero or not, so a series
   * that clears goes to 0 rather than vanishing. Both labels come from closed
   * vocabularies in `job-health.ts`; neither can carry a tenant or a person.
   */
  jobHealth: JobHealthCount[];
  /** Whether pg-boss's table could be read; false disables orphan detection. */
  jobQueueReadable: boolean;
}

/**
 * pg-boss's own table, read directly.
 *
 * It is not in `schema.prisma` because it is not Syntra's — pg-boss creates
 * and migrates it, and modelling somebody else's table is how a library
 * upgrade becomes a failed migration. Absent means the scheduler has never
 * started here, which is the ordinary state in a test process and a real
 * answer in a deployment.
 */
async function pendingJobs(): Promise<number | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `select count(*)::bigint as count from pgboss.job where state in ('created', 'retry')`,
    );
    return Number(rows[0]?.count ?? 0);
  } catch {
    // Undefined table. Deliberately not distinguished from any other failure
    // here: the only use of this number is a gauge, and a gauge that cannot be
    // read is a gauge that is not published.
    return null;
  }
}

/**
 * Reads every gauge, summed across tenants.
 *
 * PER TENANT, and not because that is convenient. Every table counted here is
 * under `FORCE ROW LEVEL SECURITY`, and the application connects as a role
 * with no `BYPASSRLS` — so `prisma.session.count()` with no tenant context
 * returns **zero**, not a total. That is the isolation guarantee working as
 * designed ("a query written without a `where` clause returns nothing rather
 * than another tenant's rows"), and it means an installation-wide number has
 * to be assembled from tenant-scoped reads rather than taken around them.
 *
 * The alternative — a role that can see every row — would put a `BYPASSRLS`
 * credential in the process for the sake of a dashboard. That trade is not
 * worth making, and this is the reason `cachedMetrics` exists: the cost is
 * one short transaction per tenant, paid once per cache window rather than
 * once per scrape.
 *
 * The counts are still cardinalities only. No row leaves the transaction.
 */
export async function collectMetrics(now: Date = new Date()): Promise<MetricsSnapshot> {
  // Erased tenants are tombstones: nothing to count, and binding is refused.
  const tenants = await prisma.tenant.findMany({
    where: { status: { not: TENANT_DELETED_STATUS } },
    select: { id: true },
  });

  const zero = {
    webhookDeliveriesPending: 0,
    webhookDeliveriesAbandoned: 0,
    logoutDeliveriesPending: 0,
    logoutDeliveriesAbandoned: 0,
    sessionsActive: 0,
    usersActive: 0,
    usersInactive: 0,
    accountsLocked: 0,
    lifecycleOperationsUnresolved: 0,
    lifecycleOperationsFailed: 0,
    lifecycleOperationsOverdue: 0,
    lifecycleOperationsAwaitingApproval: 0,
    lifecycleOperationsSloBreached: 0,
    lifecycleReceiptsDeferred: 0,
    provisionActionsPendingRetry: 0,
    provisionActionsFailed24h: 0,
    provisionRunsFailed24h: 0,
    targetsStale: 0,
  };

  const totals = { ...zero };
  let nearestExpiry: Date | null = null;
  let oldestUnresolved: Date | null = null;
  let oldestReadiness: Date | null = null;
  let anyReadiness = false;
  let resolvedDay = 0;
  let retriedDay = 0;
  const durations = new Map<string, number[]>();
  const receiptDurations = new Map<string, number[]>();
  const dayAgo = new Date(now.getTime() - 86_400_000);

  for (const tenant of tenants) {
    const [
      webhookPending,
      webhookAbandoned,
      logoutPending,
      logoutAbandoned,
      sessions,
      active,
      inactive,
      locked,
      lifecycleUnresolved,
      lifecycleFailed,
      lifecycleOverdue,
      key,
    ] = await withTenant(tenant.id, (tx) =>
      Promise.all([
        tx.webhookDelivery.count({
          where: { deliveredAt: null, attempts: { lt: WEBHOOK_MAX_ATTEMPTS } },
        }),
        tx.webhookDelivery.count({
          where: { deliveredAt: null, attempts: { gte: WEBHOOK_MAX_ATTEMPTS } },
        }),
        tx.logoutDelivery.count({
          where: { deliveredAt: null, attempts: { lt: WEBHOOK_MAX_ATTEMPTS } },
        }),
        tx.logoutDelivery.count({
          where: { deliveredAt: null, attempts: { gte: WEBHOOK_MAX_ATTEMPTS } },
        }),
        tx.session.count({ where: { revokedAt: null, absoluteExpiresAt: { gt: now } } }),
        tx.user.count({ where: { status: 'active' } }),
        tx.user.count({ where: { status: { not: 'active' } } }),
        // The query form of `isLocked`: locked when `lockedAt` is set AND
        // either there is no expiry -- a lock that does not lift itself -- or
        // the expiry is still ahead. Reading a null `lockedUntil` as "not
        // locked" would turn the strictest setting into the weakest.
        tx.loginLockout.count({
          where: {
            lockedAt: { not: null },
            OR: [{ lockedUntil: null }, { lockedUntil: { gt: now } }],
          },
        }),
        tx.lifecycleOperation.count({
          where: { status: { notIn: ['completed', 'cancelled'] } },
        }),
        tx.lifecycleOperation.count({ where: { status: 'failed' } }),
        tx.lifecycleOperation.count({
          where: {
            status: { notIn: ['completed', 'cancelled'] },
            dueAt: { lt: now },
            acknowledgedAt: null,
          },
        }),
        tx.signingKey.findFirst({
          where: { status: 'active' },
          orderBy: { notAfter: 'asc' },
          select: { notAfter: true },
        }),
      ]),
    );
    const capacity = await withTenant(tenant.id, async (tx) => {
      const [awaiting, breached, oldest, deferred, pendingRetry, failedActions, failedRuns, targets, resolved, applied] =
        await Promise.all([
          tx.lifecycleOperation.count({ where: { status: 'awaiting_approval' } }),
          tx.lifecycleOperation.count({
            where: {
              status: { notIn: ['completed', 'cancelled', 'rejected'] },
              OR: [{ sloBreachedAt: { not: null } }, { sloDeadlineAt: { lt: now } }],
            },
          }),
          tx.lifecycleOperation.findFirst({
            where: { status: { notIn: ['completed', 'cancelled', 'rejected'] } },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          }),
          tx.personProvisionReceipt.count({ where: { status: 'deferred' } }),
          tx.provisionAction.count({ where: { status: 'pending_retry' } }),
          tx.provisionAction.count({ where: { status: 'failed', createdAt: { gte: dayAgo } } }),
          tx.provisionRun.count({ where: { status: 'failed', startedAt: { gte: dayAgo } } }),
          tx.targetSystem.findMany({
            where: { enabled: true, schedule: { not: null } },
            select: { id: true, lastRunAt: true },
          }),
          tx.lifecycleOperation.findMany({
            where: { completedAt: { gte: dayAgo }, status: { in: ['completed', 'failed'] } },
            select: { kind: true, attempt: true, createdAt: true, completedAt: true },
          }),
          tx.personProvisionReceipt.findMany({
            where: { status: 'applied', updatedAt: { gte: dayAgo } },
            select: { targetSystemId: true, createdAt: true, updatedAt: true },
          }),
        ]);
      const targetTypes = new Map(
        (await tx.targetSystem.findMany({ select: { id: true, type: true } })).map((t) => [t.id, t.type]),
      );
      const readiness = await tx.connectionReadinessCheck.groupBy({
        by: ['systemId'],
        where: { systemKind: 'target', systemId: { in: targets.map((t) => t.id) } },
        _max: { checkedAt: true },
      });
      return { awaiting, breached, oldest, deferred, pendingRetry, failedActions, failedRuns, targets, resolved, applied, targetTypes, readiness };
    });
    totals.lifecycleOperationsAwaitingApproval += capacity.awaiting;
    totals.lifecycleOperationsSloBreached += capacity.breached;
    totals.lifecycleReceiptsDeferred += capacity.deferred;
    totals.provisionActionsPendingRetry += capacity.pendingRetry;
    totals.provisionActionsFailed24h += capacity.failedActions;
    totals.provisionRunsFailed24h += capacity.failedRuns;
    totals.targetsStale += capacity.targets.filter(
      (target) => target.lastRunAt === null || target.lastRunAt < dayAgo,
    ).length;
    if (capacity.oldest && (oldestUnresolved === null || capacity.oldest.createdAt < oldestUnresolved)) {
      oldestUnresolved = capacity.oldest.createdAt;
    }
    for (const row of capacity.readiness) {
      const checkedAt = row._max.checkedAt;
      if (!checkedAt) continue;
      anyReadiness = true;
      if (oldestReadiness === null || checkedAt < oldestReadiness) oldestReadiness = checkedAt;
    }
    for (const operation of capacity.resolved) {
      resolvedDay += 1;
      if (operation.attempt > 1) retriedDay += 1;
      if (operation.completedAt) {
        const list = durations.get(operation.kind) ?? [];
        list.push((operation.completedAt.getTime() - operation.createdAt.getTime()) / 1000);
        durations.set(operation.kind, list);
      }
    }
    for (const receipt of capacity.applied) {
      const type = capacity.targetTypes.get(receipt.targetSystemId) ?? 'unknown';
      const list = receiptDurations.get(type) ?? [];
      list.push((receipt.updatedAt.getTime() - receipt.createdAt.getTime()) / 1000);
      receiptDurations.set(type, list);
    }

    totals.webhookDeliveriesPending += webhookPending;
    totals.webhookDeliveriesAbandoned += webhookAbandoned;
    totals.logoutDeliveriesPending += logoutPending;
    totals.logoutDeliveriesAbandoned += logoutAbandoned;
    totals.sessionsActive += sessions;
    totals.usersActive += active;
    totals.usersInactive += inactive;
    totals.accountsLocked += locked;
    totals.lifecycleOperationsUnresolved += lifecycleUnresolved;
    totals.lifecycleOperationsFailed += lifecycleFailed;
    totals.lifecycleOperationsOverdue += lifecycleOverdue;

    // The NEAREST expiry across the installation, because one tenant's key
    // expiring is one tenant's outage and the alert should fire for it.
    if (key !== null && (nearestExpiry === null || key.notAfter < nearestExpiry)) {
      nearestExpiry = key.notAfter;
    }
  }

  const quantiles = <K extends string>(source: Map<string, number[]>, label: K) =>
    [...source].flatMap(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      return [
        { [label]: key, quantile: '0.5', seconds: at(0.5) },
        { [label]: key, quantile: '0.95', seconds: at(0.95) },
      ] as ({ [P in K]: string } & { quantile: string; seconds: number })[];
    });

  // Imported when used: job health reads the run services, which record audit
  // events, which count themselves here -- a static import would be a cycle.
  const { jobHealthCounts } = await import('../jobs/job-health.js');
  const jobHealth = await jobHealthCounts(tenants.map((tenant) => tenant.id), { now });

  return {
    ...totals,
    jobHealth: jobHealth.counts,
    jobQueueReadable: jobHealth.queueReadable,
    lifecycleOldestUnresolvedAgeSeconds:
      oldestUnresolved === null ? null : Math.max(0, Math.floor((now.getTime() - oldestUnresolved.getTime()) / 1000)),
    lifecycleRetryRate: resolvedDay === 0 ? null : retriedDay / resolvedDay,
    readinessFreshnessSeconds:
      !anyReadiness || oldestReadiness === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - oldestReadiness.getTime()) / 1000)),
    lifecycleOperationDurationSeconds: quantiles(durations, 'kind'),
    targetOperationDurationSeconds: quantiles(receiptDurations, 'targetType'),
    jobsPending: await pendingJobs(),
    signingKeyExpiresInSeconds:
      nearestExpiry === null
        ? null
        : Math.max(0, Math.floor((nearestExpiry.getTime() - now.getTime()) / 1000)),
  };
}

/**
 * `collectMetrics` behind a short cache.
 *
 * A scraper is a machine on a timer, and a misconfigured one polls every
 * second. Ten seconds of cache means a normal fifteen-second scrape pays for
 * the queries once and a pathological one cannot multiply the load on the
 * database it is trying to observe.
 *
 * The in-flight promise is shared, not just the result: two scrapes arriving
 * together issue one set of queries between them rather than one each, which
 * is the case a plain timestamp check misses.
 */
export function cachedMetrics(
  ttlMs = 10_000,
  collect: (now?: Date) => Promise<MetricsSnapshot> = collectMetrics,
): () => Promise<MetricsSnapshot> {
  let cached: { at: number; snapshot: MetricsSnapshot } | null = null;
  let inFlight: Promise<MetricsSnapshot> | null = null;

  return async () => {
    const now = Date.now();
    if (cached !== null && now - cached.at < ttlMs) return cached.snapshot;
    if (inFlight !== null) return inFlight;

    inFlight = collect()
      .then((snapshot) => {
        cached = { at: Date.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };
}

/**
 * How many security events this process has recorded, by action and outcome.
 *
 * A plain map rather than a Prometheus Counter, because core must not depend
 * on the metrics library: `recordEvent` lives here and the registry lives in
 * `apps/api`. The route reads this and copies it onto a Counter at scrape
 * time.
 *
 * PROCESS-LOCAL, and honestly so. It resets when the process restarts and a
 * two-process deployment reports two series — that is what a counter is, and
 * Prometheus knows how to handle both.
 *
 * The label set is bounded by the security allowlist, which is the only reason
 * it is bounded at all. Counting every audited action would grow the series
 * set with the audit vocabulary, and the vocabulary grows with the product.
 */
const auditCounts = new Map<string, number>();

export function countSecurityEvent(action: string, outcome: string): void {
  const key = `${action} ${outcome}`;
  auditCounts.set(key, (auditCounts.get(key) ?? 0) + 1);
}

export interface AuditCount {
  action: string;
  outcome: string;
  count: number;
}

export function securityEventCounts(): AuditCount[] {
  return [...auditCounts].map(([key, count]) => {
    const [action, outcome] = key.split(' ');
    return { action: action!, outcome: outcome!, count };
  });
}

/** Testing only: the counter is process-local and a suite shares the process. */
export function resetSecurityEventCounts(): void {
  auditCounts.clear();
}
