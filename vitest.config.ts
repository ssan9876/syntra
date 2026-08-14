import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    testTimeout: 30_000,
    // Integration tests share one PostgreSQL database and truncate between
    // tests. Parallel forks would race on the same rows.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
