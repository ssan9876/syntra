import type { Scheduler } from '@syntra/core';

/**
 * What a graceful stop has to close, in the order it has to close them.
 *
 * Narrower than `FastifyInstance` and `PrismaClient` on purpose: this module
 * is about ORDER, and a test that has to stand up a real server and a real
 * database to check the order is a test nobody writes.
 */
export interface Closeables {
  /** Fastify. `close()` stops accepting and drains what is in flight. */
  app: { close(): Promise<void>; log: { info(o: object, m: string): void; error(o: object, m: string): void } };
  /** Null when the scheduler failed to start — the API runs without it. */
  scheduler(): Scheduler | null;
  /** Prisma. The pool holds sockets that outlive the HTTP server. */
  disconnect(): Promise<void>;
}

/**
 * Closes the process down in the one order that does not manufacture failures.
 *
 * HTTP FIRST. A request in flight may enqueue a job — a source saved from the
 * console reschedules it there and then — and a scheduler stopped underneath
 * that request turns an ordinary save into a 500 at the exact moment the
 * operator is least able to tell a shutdown from a fault. Draining HTTP first
 * means nothing can enqueue by the time the scheduler goes.
 *
 * Then the scheduler, whose `stop()` is `boss.stop({ graceful: true })` and
 * waits for the sync run already reading a directory. Then Prisma, which both
 * of the above are still using until they are done.
 *
 * Every step is independent: one failing must not leave the next unclosed, so
 * each is logged and the sequence carries on. A half-closed process that
 * reports what it could not close beats one that stopped at the first error
 * holding a connection pool.
 */
export function shutdownHandler(closeables: Closeables): (signal: string) => Promise<void> {
  // Per handler, not per module. Kubernetes sends SIGTERM and then SIGKILL,
  // and an operator pressing Ctrl-C twice is not asking for two shutdowns —
  // the second would call `close()` on an already-closing server.
  let closing = false;

  return async (signal: string) => {
    if (closing) return;
    closing = true;

    const { app } = closeables;
    app.log.info({ signal }, 'shutting down');

    const step = async (what: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (cause) {
        app.log.error({ err: cause, what }, 'could not close cleanly during shutdown');
      }
    };

    await step('http', () => app.close());
    const scheduler = closeables.scheduler();
    if (scheduler !== null) await step('scheduler', () => scheduler.stop());
    await step('database', () => closeables.disconnect());

    app.log.info({ signal }, 'shutdown complete');
  };
}
