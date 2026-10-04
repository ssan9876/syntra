import pg from 'pg';

/**
 * A node-postgres client that runs the queries handed to it one at a time.
 *
 * Prisma 7's query interpreter loads an `include` by running each relation's
 * query at once (`Promise.all` over the join's children). Outside a
 * transaction each goes to the pool and gets a connection of its own; inside
 * one -- every `withTenant` -- they all land on the transaction's single
 * connection. pg 8 queues them internally and prints, once per process:
 *
 *   DeprecationWarning: Calling client.query() when the client is already
 *   executing a query is deprecated and will be removed in pg@9.0
 *
 * pg 9 removes that queue. This is the same queue, kept on our side: first
 * called, first run, and a failed query does not stop the ones behind it --
 * exactly what pg 8 does today, so nothing about the results changes.
 *
 * Only the promise form is queued. A callback or a `Submittable` (a cursor,
 * a stream) goes straight through: nothing here issues one on a connection
 * that is busy, and both have their own completion contract to keep.
 */
export class SerialClient extends pg.Client {
  #tail: Promise<unknown> = Promise.resolve();

  constructor(config?: string | pg.ClientConfig) {
    super(config);
    // Assigned rather than declared as an override: `query` is a set of
    // overloads, and an override would have to replace every one of them with
    // a single signature that serves none of its callers.
    this.query = ((...args: unknown[]) => this.#enqueue(args)) as pg.Client['query'];
  }

  #enqueue(args: unknown[]): unknown {
    // Looked up per call rather than captured: the tests watch it.
    const run = () => Reflect.apply(pg.Client.prototype.query, this, args) as unknown;
    const [config, values, callback] = args;
    if (
      typeof values === 'function' ||
      typeof callback === 'function' ||
      typeof (config as { submit?: unknown } | null)?.submit === 'function'
    ) {
      return run();
    }

    const result = this.#tail.then(run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
