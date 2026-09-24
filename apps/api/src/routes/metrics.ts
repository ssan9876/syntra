import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
} from '@prometheus-io/client';
import {
  buildInfo,
  cachedMetrics,
  securityEventCounts,
  type MetricsSnapshot,
} from '@syntra/core';

export interface MetricsRouteOptions {
  /** Null means the route is never registered. */
  token: string | null;
  /**
   * Whether this process can do its job, as `/health/ready` computes it.
   *
   * Passed in rather than computed here so there is ONE readiness definition:
   * a second one that drifted would have a dashboard and a load balancer
   * disagreeing about whether the service is up, which is the worst possible
   * pair of answers.
   */
  isReady: () => Promise<boolean>;
  /** Process-local worker status; independent of sign-in readiness. */
  schedulerRunning?: () => boolean;
}

/**
 * Constant-time, and length-safe.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal and a 500. Comparing lengths first and returning early is not
 * a leak worth caring about — the length of a token an operator configured is
 * not the secret — but throwing would be.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The metrics this process holds in memory.
 *
 * A registry of its own rather than the library's global one, so a test can
 * build two apps in one process without their series bleeding together.
 */
export interface MetricsHandles {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  setGauges: (snapshot: MetricsSnapshot) => void;
  setReadiness: (ready: boolean) => void;
  copyAuditCounts: () => void;
}

/** Named, because `publish` needs the name and the metric does not carry it. */
const JOBS_PENDING = 'syntra_jobs_pending';
const KEY_EXPIRY = 'syntra_signing_key_expires_in_seconds';
const OLDEST_UNRESOLVED = 'syntra_lifecycle_oldest_unresolved_age_seconds';
const RETRY_RATE = 'syntra_lifecycle_retry_rate';
const READINESS_FRESHNESS = 'syntra_target_readiness_age_seconds';

function buildRegistry(): MetricsHandles {
  const registry = new Registry();

  // Heap, CPU, event-loop lag, handles. These are what somebody actually wants
  // when the API is slow, and hand-rolling an event-loop lag histogram to save
  // a dependency would be the wrong trade in an auth product.
  collectDefaultMetrics({ register: registry, prefix: 'syntra_' });

  new Gauge({
    name: 'syntra_build_info',
    help: 'The running version, as a label on a constant 1.',
    labelNames: ['version'],
    registers: [registry],
  }).set({ version: buildInfo().version }, 1);

  const httpDuration = new Histogram({
    name: 'syntra_http_request_duration_seconds',
    help: 'Request duration by route pattern.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  // One gauge per field of the snapshot. Declared once here rather than built
  // from the object's keys, so the metric names and their help text are
  // readable in this file instead of being derived from a type at runtime.
  const gauge = (name: string, help: string) =>
    new Gauge({ name, help, registers: [registry] });

  const webhookPending = gauge(
    'syntra_webhook_deliveries_pending',
    'Webhook deliveries waiting, across the installation.',
  );
  const webhookAbandoned = gauge(
    'syntra_webhook_deliveries_abandoned',
    'Webhook deliveries that have exhausted their retries.',
  );
  const logoutPending = gauge(
    'syntra_logout_deliveries_pending',
    'Back-channel logout tokens waiting to reach a relying party.',
  );
  const logoutAbandoned = gauge(
    'syntra_logout_deliveries_abandoned',
    'Back-channel logouts that were never delivered. A failed offboarding.',
  );
  const sessionsActive = gauge('syntra_sessions_active', 'Live sessions.');
  const readiness = gauge(
    'syntra_readiness',
    '1 when this process can do its job, 0 when it cannot. The /health/ready probe.',
  );
  const accountsLocked = gauge(
    'syntra_accounts_locked',
    'Accounts currently locked out by failed sign-ins.',
  );
  const lifecycleUnresolved = gauge(
    'syntra_lifecycle_operations_unresolved',
    'Lifecycle operations that have not reached a terminal state.',
  );
  const lifecycleFailed = gauge(
    'syntra_lifecycle_operations_failed',
    'Lifecycle operations currently failed and requiring recovery.',
  );
  const lifecycleOverdue = gauge(
    'syntra_lifecycle_operations_overdue',
    'Unacknowledged lifecycle operations past their due time.',
  );
  const lifecycleAwaiting = gauge(
    'syntra_lifecycle_operations_awaiting_approval',
    'Lifecycle operations waiting for a second person to approve them.',
  );
  const lifecycleBreached = gauge(
    'syntra_lifecycle_operations_slo_breached',
    'Unresolved lifecycle operations past their service-level deadline.',
  );
  const receiptsDeferred = gauge(
    'syntra_lifecycle_receipts_deferred',
    'Target operations stepping back from a saturated tenant (concurrency cap reached).',
  );
  const actionsPendingRetry = gauge(
    'syntra_provision_actions_pending_retry',
    'Provisioning actions that exhausted their retries and wait for the next run.',
  );
  const actionsFailedDay = gauge(
    'syntra_provision_actions_failed_24h',
    'Provisioning actions that failed permanently in the last day.',
  );
  const runsFailedDay = gauge(
    'syntra_provision_runs_failed_24h',
    'Provisioning runs that failed in the last day.',
  );
  const targetsStale = gauge(
    'syntra_targets_stale',
    'Enabled, scheduled targets that have not run in a day, or never.',
  );
  const operationDuration = new Gauge({
    name: 'syntra_lifecycle_operation_duration_seconds',
    help: 'Duration quantiles of lifecycle operations resolved in the last day, by kind.',
    labelNames: ['kind', 'quantile'] as const,
    registers: [registry],
  });
  const targetDuration = new Gauge({
    name: 'syntra_target_operation_duration_seconds',
    help: 'Duration quantiles of applied target operations in the last day, by connector type (never by target).',
    labelNames: ['target_type', 'quantile'] as const,
    registers: [registry],
  });
  const oldestUnresolved = gauge(
    OLDEST_UNRESOLVED,
    'Age of the oldest unresolved lifecycle operation. Absent when nothing is unresolved.',
  );
  const retryRate = gauge(
    RETRY_RATE,
    'Fraction of lifecycle operations resolved in the last day that needed more than one attempt. Absent when none resolved.',
  );
  const readinessFreshness = gauge(
    READINESS_FRESHNESS,
    'Age of the oldest current target readiness check. Absent when no target has been tested.',
  );
  const jobsPending = gauge(
    JOBS_PENDING,
    'Scheduler jobs waiting. Absent where the scheduler has never run.',
  );
  const keyExpiry = gauge(
    KEY_EXPIRY,
    'Seconds until the nearest signing key expires. Absent where none exists.',
  );
  // Queue recovery (backlog #57). Both labels are closed vocabularies from
  // `job-health.ts`: the kind of work and the finding. Never a tenant, a
  // queue payload or an id.
  const jobHealth = new Gauge({
    name: 'syntra_job_health_findings',
    help: 'Background work that is orphaned, stuck, duplicated, delayed, poisoned or deferred by saturation, by kind of work.',
    labelNames: ['kind', 'finding'] as const,
    registers: [registry],
  });
  const jobQueueReadable = gauge(
    'syntra_job_queue_readable',
    '1 when the job queue could be read for health checks; 0 means orphaned work cannot be detected.',
  );
  const usersTotal = new Gauge({
    name: 'syntra_users_total',
    help: 'Accounts by status.',
    labelNames: ['status'] as const,
    registers: [registry],
  });

  /**
   * Sets a gauge, or removes it from the registry when the answer is unknown.
   *
   * Registration is idempotent here rather than conditional on a lookup: a
   * gauge already registered is registered again harmlessly, and the
   * alternative -- checking first -- is a second way to be wrong about the
   * registry's contents.
   */
  const publish = (name: string, metric: Gauge, value: number | null) => {
    if (value === null) {
      registry.removeSingleMetric(name);
      return;
    }
    if (registry.getSingleMetric(name) === undefined) {
      registry.registerMetric(metric);
    }
    metric.set(value);
  };

  const setGauges = (snapshot: MetricsSnapshot) => {
    webhookPending.set(snapshot.webhookDeliveriesPending);
    webhookAbandoned.set(snapshot.webhookDeliveriesAbandoned);
    logoutPending.set(snapshot.logoutDeliveriesPending);
    logoutAbandoned.set(snapshot.logoutDeliveriesAbandoned);
    sessionsActive.set(snapshot.sessionsActive);
    accountsLocked.set(snapshot.accountsLocked);
    lifecycleUnresolved.set(snapshot.lifecycleOperationsUnresolved);
    lifecycleFailed.set(snapshot.lifecycleOperationsFailed);
    lifecycleOverdue.set(snapshot.lifecycleOperationsOverdue);
    lifecycleAwaiting.set(snapshot.lifecycleOperationsAwaitingApproval);
    lifecycleBreached.set(snapshot.lifecycleOperationsSloBreached);
    receiptsDeferred.set(snapshot.lifecycleReceiptsDeferred);
    actionsPendingRetry.set(snapshot.provisionActionsPendingRetry);
    actionsFailedDay.set(snapshot.provisionActionsFailed24h);
    runsFailedDay.set(snapshot.provisionRunsFailed24h);
    targetsStale.set(snapshot.targetsStale);
    operationDuration.reset();
    for (const row of snapshot.lifecycleOperationDurationSeconds) {
      operationDuration.set({ kind: row.kind, quantile: row.quantile }, row.seconds);
    }
    targetDuration.reset();
    for (const row of snapshot.targetOperationDurationSeconds) {
      targetDuration.set({ target_type: row.targetType, quantile: row.quantile }, row.seconds);
    }
    for (const row of snapshot.jobHealth) {
      jobHealth.set({ kind: row.kind, finding: row.finding }, row.count);
    }
    jobQueueReadable.set(snapshot.jobQueueReadable ? 1 : 0);
    usersTotal.set({ status: 'active' }, snapshot.usersActive);
    usersTotal.set({ status: 'inactive' }, snapshot.usersInactive);

    // Null is not zero, and an unknown answer is not published AT ALL.
    //
    // `gauge.reset()` is not the way to do that: it sets the value to 0, which
    // is precisely the lie being avoided. `jobsPending: 0` reads as "the queue
    // is empty" when the truth is "nothing is processing it", and a key expiry
    // of 0 reads as "expires now" and pages somebody at three in the morning
    // for a deployment that has issued no tokens. So the metric is taken OUT
    // of the registry while the answer is unknown, and put back when it is
    // known -- an absent series, which is what Prometheus understands as "no
    // data" and what an alert rule can be written against.
    publish(JOBS_PENDING, jobsPending, snapshot.jobsPending);
    publish(KEY_EXPIRY, keyExpiry, snapshot.signingKeyExpiresInSeconds);
    publish(OLDEST_UNRESOLVED, oldestUnresolved, snapshot.lifecycleOldestUnresolvedAgeSeconds);
    publish(RETRY_RATE, retryRate, snapshot.lifecycleRetryRate);
    publish(READINESS_FRESHNESS, readinessFreshness, snapshot.readinessFreshnessSeconds);
  };

  // Core counts security events in a plain map, because core must not depend
  // on the metrics library. This copies that map onto a Counter at scrape
  // time. `inc` by the delta rather than `set`, because a Counter has no
  // setter -- so the last copied value is tracked per series.
  const auditEvents = new Counter({
    name: 'syntra_audit_events_total',
    help: 'Security-relevant audit events recorded by this process.',
    labelNames: ['action', 'outcome'] as const,
    registers: [registry],
  });
  const copied = new Map<string, number>();

  const copyAuditCounts = () => {
    for (const { action, outcome, count } of securityEventCounts()) {
      const key = `${action} ${outcome}`;
      const delta = count - (copied.get(key) ?? 0);
      if (delta > 0) {
        auditEvents.inc({ action, outcome }, delta);
        copied.set(key, count);
      }
    }
  };

  const setReadiness = (ready: boolean) => readiness.set(ready ? 1 : 0);

  return { registry, httpDuration, setGauges, setReadiness, copyAuditCounts };
}

/**
 * `GET /metrics`, or nothing at all.
 *
 * With no token configured this registers NOTHING — no route, no hook, no
 * registry. An installation that never opted in answers 404, which is the
 * point: a route answering 403 would confirm its own existence, and the
 * existence of a metrics endpoint tells somebody probing what this deployment
 * is and how it is operated.
 *
 * No label anywhere carries a tenant id, a tenant slug, or a uuid from a URL.
 * Every series is installation-wide, so a scrape cannot enumerate customers or
 * count them, and cardinality does not grow with them — which is the ordinary
 * way a Prometheus instance is brought down by its own success. An operator
 * debugging one tenant has the audit log and the console, both authenticated
 * and both better at it than a time series.
 */
export async function registerMetricsRoutes(
  app: FastifyInstance,
  options: MetricsRouteOptions,
): Promise<void> {
  const token = options.token;
  if (token === null) return;

  const { registry, httpDuration, setGauges, setReadiness, copyAuditCounts } =
    buildRegistry();
  const schedulerRunning = options.schedulerRunning
    ? new Gauge({
        name: 'syntra_scheduler_running',
        help: '1 when the background scheduler has started, 0 while startup is retrying.',
        registers: [registry],
      })
    : null;

  // Ten seconds, so a normal fifteen-second scrape pays for the queries once
  // and a misconfigured one polling every second cannot multiply the load on
  // the database it is trying to observe. `collectMetrics` runs one short
  // transaction per tenant -- see its docstring for why it cannot do better.
  const readSnapshot = cachedMetrics();

  app.addHook('onResponse', async (request, reply) => {
    // `routeOptions.url` is Fastify's REGISTERED PATTERN --
    // `/api/admin/users/:id/sessions` -- and never `request.url`. A raw URL
    // would put user ids and tenant hostnames into label values: unbounded
    // cardinality and a disclosure in one move, and a 404 for a scanned path
    // would let anybody mint a new series per probe.
    const route = request.routeOptions?.url ?? 'unrouted';
    httpDuration.observe(
      {
        method: request.method,
        route,
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get(
    '/metrics',
    {
      // The same limit `/health/ready` carries, for the same reason: this
      // endpoint is not free and is reachable with one credential.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const header = request.headers.authorization;
      const presented = header?.startsWith('Bearer ') ? header.slice(7) : null;

      // Absent, malformed and wrong all take the same exit with the same body.
      // Telling them apart would say whether a token was the right shape.
      if (presented === null || !tokenMatches(presented, token)) {
        return reply.code(401).send();
      }

      setGauges(await readSnapshot());
      if (schedulerRunning && options.schedulerRunning) {
        schedulerRunning.set(options.schedulerRunning() ? 1 : 0);
      }
      // Never allowed to fail the scrape: a readiness probe that throws would
      // take the metrics down at exactly the moment they are being consulted.
      setReadiness(await options.isReady().catch(() => false));
      copyAuditCounts();

      return reply
        .header('content-type', registry.contentType)
        .send(await registry.metrics());
    },
  );
}
