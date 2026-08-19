import { describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { testWorkerCount } from './test-database.js';

/**
 * Each worker owns its own database, and this is what says so out loud.
 *
 * Without it the isolation is invisible: collapse the shards back onto one
 * database and every test in the repository still passes, right up until two
 * workers truncate each other mid-test and produce a run of failures that name
 * no assertion. That has happened three times on this project — once as 116
 * failures containing not one assertion — and each time the diagnosis cost
 * more than the defect.
 *
 * So the property is asserted where a change to it becomes a red test rather
 * than a slow-acting silence.
 */
describe('one worker, one database', () => {
  const shard = Number.parseInt(process.env.VITEST_POOL_ID ?? '1', 10);

  it('is connected to the database named for this worker', async () => {
    const base = process.env.SYNTRA_TEST_DB_BASE;
    // Absent means the operator exported `DATABASE_URL` and owns the database:
    // sharding is off by design, and asserting our naming on their database
    // would fail CI for a reason that is not a defect.
    if (base === undefined || base === '') return;

    const [row] = await prisma.$queryRaw<{ current_database: string }[]>`
      SELECT current_database()
    `;

    // Not `toContain('_w')`: that would pass on `_w1` for every worker, which
    // is precisely the collapsed state this test exists to catch. It has to be
    // THIS worker's name.
    expect(row?.current_database).toBe(`${base}_w${shard}`);
  });

  it('reports a worker id inside the provisioned range', async () => {
    // `minForks`/`maxForks` are pinned to `testWorkerCount()` and the global
    // setup provisions exactly that many. A worker numbered outside the range
    // would be connected to a database nothing migrated, so this fails loudly
    // rather than as a confusing "relation does not exist" in some other file.
    expect(shard).toBeGreaterThanOrEqual(1);
    expect(shard).toBeLessThanOrEqual(testWorkerCount());
  });
});
