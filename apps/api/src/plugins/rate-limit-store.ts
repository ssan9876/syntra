import { prisma } from '@syntra/db';

/**
 * A `@fastify/rate-limit` store whose counters live in Postgres, so every API
 * replica counts against the same number.
 *
 * WHY. The limiter's default store is an LRU inside the process. Behind a load
 * balancer with N replicas each of them granted the whole allowance, so the
 * effective limit was N times the configured one — and the limit that suffers
 * most is the per-tenant credential ceiling (`perTenantRateLimit`), whose
 * entire purpose is to hold however widely an attacker spreads their attempts.
 * Postgres is the one thing every replica already shares; Redis would be a new
 * piece of infrastructure to run for one counter.
 *
 * SEMANTICS are the default store's, kept on purpose so switching stores
 * changes where the number lives and nothing else:
 *
 *   - A fixed window per key that starts at the key's first hit (not at a
 *     wall-clock boundary), and a hit at or after its end starts a new one
 *     with a count of one.
 *   - `ttl` is the time left in the current window, in milliseconds.
 *   - `continueExceeding` restarts the window on every hit past `max`.
 *   - Each route with its own `config.rateLimit`, and each `createRateLimit`
 *     limiter, has its own counters — the default store gives each of them a
 *     separate LRU, and this gives each a separate key prefix.
 *
 * `exponentialBackoff` is refused at construction rather than approximated:
 * nothing in Syntra uses it, and a store that silently ignored an option would
 * be a limit that is not the one configured.
 *
 * COST. One `INSERT … ON CONFLICT DO UPDATE … RETURNING` per limited request,
 * outside any transaction: a single round trip on an indexed primary key.
 * Only routes that carry a limit pay it — the limiter is registered
 * `global: false`. The database's clock is used for every comparison, so two
 * replicas whose clocks disagree still agree on when a window ends.
 */

/** What the store needs from the database. A seam for the tests. */
export interface RateLimitCounter {
  /** Counts one hit against `key` and returns the window's state after it. */
  hit(
    key: string,
    windowMs: number,
    restartPastMax: { max: number } | null,
  ): Promise<{ hits: number; ttlMs: number }>;
  /** Deletes windows that have ended. Returns how many. */
  sweep(): Promise<number>;
}

/**
 * The Postgres counter.
 *
 * Both CASE arms read the row's OLD values (that is what the table-qualified
 * names mean inside `DO UPDATE SET`), so "has this window ended" is asked once,
 * of the same row, for both columns. `RETURNING` sees the new ones.
 *
 * `resetAt` is a `timestamp without time zone` holding UTC, which is how
 * Prisma stores every `DateTime`; `now() AT TIME ZONE 'UTC'` compares like
 * with like whatever the session's TimeZone happens to be.
 */
export const postgresRateLimitCounter: RateLimitCounter = {
  async hit(key, windowMs, restartPastMax) {
    const restart = restartPastMax !== null;
    const max = restartPastMax?.max ?? 0;
    const rows = await prisma.$queryRaw<{ hits: number; ttlMs: number }[]>`
      INSERT INTO "RateLimitBucket" ("key", "hits", "resetAt")
      VALUES (
        ${key},
        1,
        (now() AT TIME ZONE 'UTC') + make_interval(secs => ${windowMs}::float8 / 1000)
      )
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE
          WHEN "RateLimitBucket"."resetAt" <= (now() AT TIME ZONE 'UTC') THEN 1
          ELSE "RateLimitBucket"."hits" + 1
        END,
        "resetAt" = CASE
          WHEN "RateLimitBucket"."resetAt" <= (now() AT TIME ZONE 'UTC') THEN EXCLUDED."resetAt"
          WHEN ${restart} AND "RateLimitBucket"."hits" + 1 > ${max}::int THEN EXCLUDED."resetAt"
          ELSE "RateLimitBucket"."resetAt"
        END
      RETURNING
        "hits",
        GREATEST(
          0,
          EXTRACT(EPOCH FROM ("resetAt" - (now() AT TIME ZONE 'UTC'))) * 1000
        )::float8 AS "ttlMs"
    `;
    const row = rows[0];
    if (!row) throw new Error('rate-limit upsert returned no row');
    return { hits: Number(row.hits), ttlMs: Math.ceil(Number(row.ttlMs)) };
  },

  async sweep() {
    // Bounded, so one sweep after a long quiet spell is not one enormous
    // DELETE holding locks on rows a live request is about to upsert. The
    // next sweep takes the rest. A key deleted here and hit again a moment
    // later simply starts a new window — which is what its expiry meant.
    return prisma.$executeRaw`
      DELETE FROM "RateLimitBucket"
       WHERE "key" IN (
         SELECT "key" FROM "RateLimitBucket"
          WHERE "resetAt" <= (now() AT TIME ZONE 'UTC')
          LIMIT 10000
       )
    `;
  },
};

/** The slice of `@fastify/rate-limit`'s merged parameters a store reads. */
interface StoreParams {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
  routeInfo?: { method?: string | string[]; url?: string };
}

type IncrCallback = (
  error: Error | null,
  result?: { current: number; ttl: number },
) => void;

/**
 * The store class `@fastify/rate-limit` instantiates (`new Store(params)`),
 * bound to a counter.
 *
 * A class-returning factory because the plugin takes a constructor, not an
 * instance, and hands it only its own parameters — the counter has to arrive
 * by closure.
 */
export function sharedRateLimitStore(counter: RateLimitCounter = postgresRateLimitCounter) {
  return class SharedRateLimitStore {
    readonly continueExceeding: boolean;
    readonly prefix: string;

    // `object`, cast below: the plugin's published types describe these
    // arguments as its options and a RouteOptions, but at runtime both are
    // its merged parameters (with `routeInfo` on a child). Only the fields
    // in `StoreParams` are read.
    constructor(options: object, prefix = 'global') {
      const params = options as StoreParams;
      if (params.exponentialBackoff) {
        throw new Error('the shared rate-limit store does not implement exponentialBackoff');
      }
      this.continueExceeding = params.continueExceeding === true;
      this.prefix = prefix;
    }

    /**
     * `timeWindow` and `max` are optional only in the plugin's published type;
     * its `applyRateLimit` always passes both (already resolved to numbers),
     * and a store cannot count without the window, so their absence is a bug
     * worth failing loudly on rather than guessing a default.
     */
    incr(key: string, callback: IncrCallback, timeWindow?: number, max?: number): void {
      if (timeWindow === undefined || max === undefined) {
        callback(new Error('rate-limit store called without a time window and max'));
        return;
      }
      counter
        .hit(
          `${this.prefix}|${key}`,
          timeWindow,
          this.continueExceeding ? { max } : null,
        )
        .then(
          ({ hits, ttlMs }) => callback(null, { current: hits, ttl: ttlMs }),
          (error: unknown) =>
            callback(error instanceof Error ? error : new Error(String(error))),
        );
    }

    /**
     * One namespace per route, and one per `createRateLimit` limiter.
     *
     * A route's is its method and URL, which is the same on every replica.
     * A `createRateLimit` limiter has no route (`routeInfo` is `{}`), so all of
     * them share the `limiter` prefix, and their keys must carry their own
     * scope — `perTenantRateLimit` puts one in every key it generates, and
     * refuses a scope used twice.
     */
    child(routeOptions: object): SharedRateLimitStore {
      const route = (routeOptions as StoreParams).routeInfo;
      const prefix =
        route?.url !== undefined
          ? `route:${[route.method ?? ''].flat().join(',')} ${route.url}`
          : 'limiter';
      return new SharedRateLimitStore(routeOptions, prefix);
    }
  };
}

/**
 * Deletes ended windows every `intervalMs` until the returned function is
 * called.
 *
 * Every replica runs one; a sweep that finds nothing is an index range scan
 * returning no rows, and two replicas deleting the same expired row is
 * harmless. Unref'd, so it never holds a process open on its own.
 */
export function startRateLimitSweeper(
  counter: RateLimitCounter,
  onError: (error: unknown) => void,
  intervalMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    counter.sweep().catch(onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
