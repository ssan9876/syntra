import { defineConfig } from 'vitest/config';
import { testDatabaseConfig } from './packages/db/src/test-database.js';

/**
 * The suite runs against a database of its own, created by the global setup.
 *
 * `env` is how the name reaches the worker processes: Prisma's client reads
 * `DATABASE_URL` at import time, and it loads `.env` itself when the variable
 * is absent, so anything set later than this is too late. `test-database.ts`
 * explains why sharing the development database is not an option.
 */
const database = testDatabaseConfig();

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
    env: {
      DATABASE_URL: database.appUrl,
      ...(database.superuserUrl ? { SUPERUSER_DATABASE_URL: database.superuserUrl } : {}),
    },
    // Integration tests share one PostgreSQL database and truncate between
    // tests. Parallel forks would race on the same rows.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
