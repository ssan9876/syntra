import { PgBoss } from 'pg-boss';
import { TenantRetiredError } from '@syntra/db';
import {
  extractContext,
  isCorrelationId,
  jobTraceCarrier,
  JOB_TRACE_KEY,
  newCorrelationId,
  SpanKind,
  splitJobPayload,
  withCorrelation,
  withSpan,
} from '@syntra/connectors';
import { missingFrom, trackIntents, type ScheduleRef } from './reconcile.js';

export type JobHandler<T> = (data: T) => Promise<void>;

export interface Scheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  register<T>(name: string, handler: JobHandler<T>): void;
  enqueue<T>(name: string, data: T, options?: { startAfterSeconds?: number }): Promise<string | null>;
  /**
   * `key` distinguishes several schedules on one queue, and is not optional
   * in practice. pg-boss keys its schedule table on `(name, key)` with `key`
   * defaulting to the empty string, so two schedules on the same queue
   * without one are the same row: the second silently replaces the first, and
   * every directory source but the last one scheduled stops running.
   */
  schedule(name: string, cron: string, data?: unknown, key?: string): Promise<void>;
  unschedule(name: string, key?: string): Promise<void>;
  /**
   * Every schedule this process asked for that pg-boss does not hold a row
   * for.
   *
   * The scheduler's callers catch per-tenant and carry on, which is right --
   * one tenant's bad cron must not cost everybody else their sync -- and
   * which means a failure hitting EVERY tenant looks exactly like one
   * tenant's bad data. This is how startup finds out the difference. See
   * `reconcile.ts` for what it cost to learn that.
   */
  missingSchedules(): Promise<ScheduleRef[]>;
}

/**
 * The payload as it is stored: the caller's data plus, under
 * `JOB_TRACE_KEY`, the correlation id of the request or job that enqueued it
 * and -- when tracing is on -- its W3C trace context.
 *
 * This is how "an HR import caused a provisioning run which called a
 * connector" stays one story across three processes' worth of queue hops:
 * each enqueue carries the id forward and `runJob` re-establishes it, so the
 * audit events, log lines and spans of every step share it.
 *
 * Only plain-object payloads are annotated; anything else is sent unchanged,
 * as is a payload enqueued outside any request or job (nothing to carry).
 */
export function withJobTrace<T>(data: T): T {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  const carrier = jobTraceCarrier();
  if (!carrier) return data;
  return { ...data, [JOB_TRACE_KEY]: carrier } as T;
}

/**
 * Run one job under its correlation id and, when tracing is on, a CONSUMER
 * span parented on the enqueuer's trace. The handler receives the payload
 * WITHOUT the trace field, so no handler schema has to know it exists.
 *
 * A job with no carrier -- a cron-scheduled one, or one enqueued before this
 * existed -- starts a fresh correlation id rather than running without one.
 *
 * Span attributes: queue name, job id, retry count and the tenant id when the
 * payload has one. Never the rest of the payload.
 */
export async function runJob<T>(
  name: string,
  job: { id: string; data: T; retryCount?: number },
  handler: JobHandler<T>,
): Promise<void> {
  const { data, carrier } = splitJobPayload(job.data);
  const tenantId = (data as { tenantId?: unknown } | null)?.tenantId;
  const parent = carrier?.traceparent
    ? extractContext({ traceparent: carrier.traceparent, ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}) })
    : undefined;
  await withSpan(
    `job ${name}`,
    {
      kind: SpanKind.CONSUMER,
      ...(parent ? { parent } : {}),
      attributes: {
        'messaging.system': 'pg-boss',
        'messaging.destination.name': name,
        'messaging.message.id': job.id,
        'syntra.job.retry_count': job.retryCount,
        'syntra.tenant_id': typeof tenantId === 'string' ? tenantId : undefined,
      },
    },
    async (span) => {
      // With tracing on and no carrier the span's own trace id becomes the
      // correlation id, so the two agree; otherwise the carried id wins.
      const traceId = span?.spanContext().traceId;
      const correlationId = carrier?.correlationId ?? (isCorrelationId(traceId) ? traceId : newCorrelationId());
      await withCorrelation(correlationId, () => handler(data));
    },
  );
}

/**
 * A thin wrapper over pg-boss, which keeps the queue in the same PostgreSQL
 * instance as everything else — no Redis, and a job enqueued in a transaction
 * commits or rolls back with it.
 *
 * Jobs carry their tenant in the payload. A background job has no request and
 * therefore no bound tenant, so a handler opens its own withTenant using what
 * it was given; there is deliberately no ambient tenant to inherit.
 */
export function createScheduler(
  databaseUrl: string,
  onError: (error: Error) => void = (error) => { process.emitWarning(error); },
): Scheduler {
  const boss = new PgBoss({ connectionString: databaseUrl });
  // EventEmitter treats an unhandled 'error' as a process-level exception.
  // pg-boss emits these for transient polling failures and keeps retrying.
  boss.on('error', onError);

  const handlers = new Map<string, JobHandler<unknown>>();
  // What this process has asked to be scheduled, so startup can check.
  const intents = trackIntents();
  let started = false;

  const assertRegistered = (name: string) => {
    if (!handlers.has(name)) {
      throw new Error(`no handler registered for job: ${name}`);
    }
  };

  return {
    register<T>(name: string, handler: JobHandler<T>) {
      handlers.set(name, handler as JobHandler<unknown>);
    },

    async start() {
      if (started) return;
      await boss.start();

      for (const [name, handler] of handlers) {
        // Retry policy belongs to the queue in pg-boss 12, not to the
        // client, so it is declared where the queue is created.
        await boss.createQueue(name, {
          name,
          retryLimit: 3,
          retryBackoff: true,
        } as Parameters<typeof boss.createQueue>[1]);
        await boss.work(name, async (jobs) => {
          for (const job of jobs) {
            // A throw is what tells pg-boss to retry. Never swallow it --
            // with one exception. A job for a tenant that has since been
            // erased can never succeed and has nothing left to do; the
            // erasure removed its schedule and queued copies, and this is the
            // copy that was already in flight. Retrying it would turn a
            // completed deletion into three failures and an alert.
            try {
              await runJob(name, job, handler);
            } catch (error) {
              if (error instanceof TenantRetiredError) continue;
              throw error;
            }
          }
        });
      }
      started = true;
    },

    async stop() {
      // pg-boss can own a pool and timers even when start() failed halfway.
      // Its stop() is idempotent and handles both partial and complete starts.
      await boss.stop({ graceful: true });
      started = false;
    },

    async enqueue<T>(name: string, data: T, options?: { startAfterSeconds?: number }) {
      assertRegistered(name);
      return boss.send(
        name,
        withJobTrace(data) as object,
        options?.startAfterSeconds === undefined ? {} : { startAfter: options.startAfterSeconds },
      );
    },

    async schedule(name: string, cron: string, data: unknown = {}, key = '') {
      assertRegistered(name);
      // Recorded BEFORE the attempt. A call that throws is precisely the one
      // worth reporting, so recording it after a successful return would
      // blind the reconciliation to every failure it exists to catch.
      intents.scheduled(name, key);
      await boss.schedule(name, cron, data as object, { key });
    },

    async unschedule(name: string, key = '') {
      intents.unscheduled(name, key);
      // Deliberately not gated on `assertRegistered`: removing a schedule has
      // to work for a queue this process never registered a handler for, or a
      // source deleted before the handler is wired up keeps firing forever.
      await boss.unschedule(name, key);
    },

    async missingSchedules() {
      // `getSchedules()` returns every row in the table, including ones this
      // process never asked for. `missingFrom` only ever asks whether what we
      // requested is present, never the reverse.
      const rows = await boss.getSchedules();
      return missingFrom(
        intents.list(),
        rows.map((row) => ({ name: row.name, key: row.key ?? '' })),
      );
    },
  };
}
