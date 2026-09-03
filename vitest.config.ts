import { defineConfig } from 'vitest/config';
import { testDatabaseConfig, testWorkerCount } from './packages/db/src/test-database.js';

/**
 * The suite runs against a database of its own, created by the global setup.
 *
 * `env` is how the name reaches the worker processes: Prisma's client reads
 * `DATABASE_URL` at import time, and it loads `.env` itself when the variable
 * is absent, so anything set later than this is too late. `test-database.ts`
 * explains why sharing the development database is not an option.
 */
const database = testDatabaseConfig();

/**
 * One worker, one database.
 *
 * `resetDatabase()` TRUNCATEs every table, so the count of workers must not
 * exceed the count of databases -- and it is literally the same call,
 * `testWorkerCount()`, that the global setup provisions against. `maxWorkers`
 * is pinned to it so vitest cannot decide to run more workers than there are
 * databases, which would put two of them on one and reproduce the failure
 * this change exists to remove.
 *
 * `maxWorkers` alone is enough, and it is all Vitest 5 offers -- `minForks`
 * and `maxForks` went with the pool rework, and there is no `minWorkers`. The
 * invariant was never "exactly this many workers": it is that a worker's
 * `VITEST_POOL_ID`, which `vitest.setup-worker.ts` turns into a database
 * name, must name a database that exists. Vitest documents that id as never
 * exceeding `maxWorkers`, so a run that decides on fewer workers simply
 * leaves the last database or two unused, which costs nothing.
 *
 * Sharding is off when the operator exported `DATABASE_URL` (`name === null`):
 * that database is theirs, not ours to shard, and the setup file leaves it
 * alone for the same reason.
 */
const shards = database.name === null ? 1 : testWorkerCount();

export default defineConfig({
  test: {
    // `apps/api`, NOT `apps/**`. The web app has its own config -- jsdom,
    // `globals: true`, and `src/test-setup.ts` -- and the three `.test.ts`
    // files under it were being matched HERE instead: run in a node
    // environment, without that setup, which is not what they were written
    // against. Its 37 `.test.tsx` files were matched by neither pattern and
    // ran nowhere at all, which is how a stale assertion in
    // StatusToggle.test.tsx sat red on main unseen.
    //
    // Widening this to `*.test.{ts,tsx}` would not work: this config has no
    // jsdom environment and no React plugin. Two configs, two commands, and
    // CI runs both.
    include: ['packages/**/src/**/*.test.ts', 'apps/api/**/src/**/*.test.ts'],
    testTimeout: 30_000,
    // The same budget as a test body, deliberately. A `beforeEach` here does
    // exactly what a test body does -- `resetDatabase()` TRUNCATEs every table
    // and the fixture then writes through `withTenant` -- and that costs ~3 s
    // on an idle machine. Vitest's 10 s default left a margin thin enough that
    // five cases in `automate/approvers.test.ts` failed with
    // "Hook timed out in 10000ms" and every one of them passed on a re-run
    // with no change to the code. A red run that says nothing about the code
    // is the most expensive kind on this programme; it has cost it days.
    hookTimeout: 30_000,
    // WAS `dangerouslyIgnoreUnhandledErrors: true`, and is deliberately not
    // any more.
    //
    // Vitest's worker<->main RPC layer (`birpc`) had a hardcoded 60s timeout
    // on internal status pings, independent of the two budgets above. Under
    // sustained load it timed out even though every test passed, and Vitest
    // reported that as an "Unhandled Error" that failed the whole run -- see
    // vitest-dev/vitest#6479, #4497, #8164. It was first hit cutting this
    // project's very first tagged release, three times running, with the
    // runner reporting every one of 3,644 tests passing and the job still red
    // on that one unrelated line. Silencing every unhandled rejection was the
    // only lever there was.
    //
    // The cost was real and this comment used to say so: the flag could not
    // tell that RPC timeout from a genuine unhandled rejection in application
    // code, so a test whose async work threw after its assertions had already
    // returned would have failed to fail.
    //
    // Vitest 5 does not produce it. Measured, not assumed: the full suite ran
    // clean with no "Unhandled Error" line and no `onTaskUpdate` timeout,
    // where every run under Vitest 3 ended with one. So the flag is gone and
    // the check it was suppressing is back. If the error ever returns, the
    // fix is to find what is rejecting -- not to reinstate this.
    globalSetup: ['./vitest.global-setup.ts'],
    // Runs in each worker BEFORE the test module, and therefore before
    // `packages/db/src/client.ts` constructs its `PrismaClient` from
    // `DATABASE_URL`. `env` below cannot do this job: it is evaluated once, in
    // this process, so every worker would receive the same value.
    setupFiles: ['./vitest.setup-worker.ts'],
    env: {
      // Shard 1's URL as the floor, not the unsharded name. Every worker
      // overwrites it in the setup file above, so this is only what a stray
      // import outside a worker would see -- but the unsharded database is
      // provisioned by nothing now that the setup migrates shards, so naming
      // it here pointed the floor at a database that does not exist. Shard 1
      // always does.
      DATABASE_URL: (database.name === null ? database : testDatabaseConfig(1)).appUrl,
      ...(database.superuserUrl ? { SUPERUSER_DATABASE_URL: database.superuserUrl } : {}),
      // The setup file re-derives nothing: it swaps this name into
      // `DATABASE_URL` and appends its own worker number. Passed rather than
      // recomputed because by the time the setup file runs, `DATABASE_URL`
      // above is already set, and `testDatabaseConfig()` reads that as "the
      // operator chose this database" -- so a worker calling it would take the
      // do-not-provision branch every time and never shard at all. Absent when
      // that branch is genuinely correct, which is what switches sharding off.
      ...(database.name === null ? {} : { SYNTRA_TEST_DB_BASE: database.name }),
    },
    pool: 'forks',
    maxWorkers: shards,
    // The `singleFork` of the old pool options. One database means every file
    // has to share it, and files that share a database cannot run beside each
    // other -- the truncate at the head of each test would pull the table out
    // from under whatever else was mid-transaction.
    ...(shards === 1 ? { fileParallelism: false } : {}),
  },
});
