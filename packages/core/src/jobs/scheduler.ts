import { PgBoss } from 'pg-boss';

export type JobHandler<T> = (data: T) => Promise<void>;

export interface Scheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  register<T>(name: string, handler: JobHandler<T>): void;
  enqueue<T>(name: string, data: T): Promise<string | null>;
  /**
   * `key` distinguishes several schedules on one queue, and is not optional
   * in practice. pg-boss keys its schedule table on `(name, key)` with `key`
   * defaulting to the empty string, so two schedules on the same queue
   * without one are the same row: the second silently replaces the first, and
   * every directory source but the last one scheduled stops running.
   */
  schedule(name: string, cron: string, data?: unknown, key?: string): Promise<void>;
  unschedule(name: string, key?: string): Promise<void>;
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
export function createScheduler(databaseUrl: string): Scheduler {
  const boss = new PgBoss({ connectionString: databaseUrl });

  const handlers = new Map<string, JobHandler<unknown>>();
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
            // A throw is what tells pg-boss to retry. Never swallow it.
            await handler(job.data);
          }
        });
      }
      started = true;
    },

    async stop() {
      if (!started) return;
      await boss.stop({ graceful: true });
      started = false;
    },

    async enqueue<T>(name: string, data: T) {
      assertRegistered(name);
      return boss.send(name, data as object);
    },

    async schedule(name: string, cron: string, data: unknown = {}, key = '') {
      assertRegistered(name);
      await boss.schedule(name, cron, data as object, { key });
    },

    async unschedule(name: string, key = '') {
      // Deliberately not gated on `assertRegistered`: removing a schedule has
      // to work for a queue this process never registered a handler for, or a
      // source deleted before the handler is wired up keeps firing forever.
      await boss.unschedule(name, key);
    },
  };
}
