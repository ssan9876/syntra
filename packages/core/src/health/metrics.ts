import { prisma, withTenant } from '@syntra/db';
import { WEBHOOK_MAX_ATTEMPTS } from '../notify/webhook-retry.js';

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
  /** Null when pg-boss has never created its schema in this database. */
  jobsPending: number | null;
  /** Null when no signing key exists yet. */
  signingKeyExpiresInSeconds: number | null;
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
  const tenants = await prisma.tenant.findMany({ select: { id: true } });

  const zero = {
    webhookDeliveriesPending: 0,
    webhookDeliveriesAbandoned: 0,
    logoutDeliveriesPending: 0,
    logoutDeliveriesAbandoned: 0,
    sessionsActive: 0,
    usersActive: 0,
    usersInactive: 0,
    accountsLocked: 0,
  };

  const totals = { ...zero };
  let nearestExpiry: Date | null = null;

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
        tx.signingKey.findFirst({
          where: { status: 'active' },
          orderBy: { notAfter: 'asc' },
          select: { notAfter: true },
        }),
      ]),
    );

    totals.webhookDeliveriesPending += webhookPending;
    totals.webhookDeliveriesAbandoned += webhookAbandoned;
    totals.logoutDeliveriesPending += logoutPending;
    totals.logoutDeliveriesAbandoned += logoutAbandoned;
    totals.sessionsActive += sessions;
    totals.usersActive += active;
    totals.usersInactive += inactive;
    totals.accountsLocked += locked;

    // The NEAREST expiry across the installation, because one tenant's key
    // expiring is one tenant's outage and the alert should fire for it.
    if (key !== null && (nearestExpiry === null || key.notAfter < nearestExpiry)) {
      nearestExpiry = key.notAfter;
    }
  }

  return {
    ...totals,
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
