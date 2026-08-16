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
