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
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
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
