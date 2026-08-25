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
 * `resetDatabase()` TRUNCATEs every table, so the count of workers and the
 * count of databases have to be the same number -- and it is literally the
 * same call, `testWorkerCount()`, that the global setup provisions against.
 * `minForks` and `maxForks` are both pinned to it so vitest cannot decide to
 * run more workers than there are databases, which would put two of them on
 * one and reproduce the failure this change exists to remove.
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
    // A KNOWN, LONG-UNFIXED VITEST BUG, NOT A SAFETY VALVE FOR THIS CODEBASE'S
    // OWN TESTS -- read the whole comment before touching this again.
    //
    // Vitest's worker<->main RPC layer (`birpc`) has a hardcoded, unconfigurable
    // 60s timeout on internal status pings, independent of testTimeout/
    // hookTimeout above. Under sustained load it can time out even though every
    // test passed, and Vitest reports that as an "Unhandled Error" that fails
    // the whole run -- see vitest-dev/vitest#6479, #4497, #8164, all open for
    // a long time with no real fix. First hit cutting this project's very
    // first tagged release, three times running, GitHub's own runner reporting
    // "Test Files 181 passed (181)", "Tests 3644 passed (3644)" and the job
    // still red on this one unrelated line.
    //
    // This does not distinguish that RPC timeout from a genuine unhandled
    // promise rejection in APPLICATION code under test -- it silences both.
    // That is a real, ongoing loss: a future test whose async work throws
    // after its own assertions already returned would now fail to fail here.
    // It was accepted anyway because the alternative -- a release pipeline
    // that cannot reliably finish a green run at all -- was worse, and no
    // narrower fix exists in this Vitest version.
    dangerouslyIgnoreUnhandledErrors: true,
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
    poolOptions: { forks: { singleFork: shards === 1, minForks: shards, maxForks: shards } },
  },
});
