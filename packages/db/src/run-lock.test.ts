import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireRunLock,
  repoRoot,
  scratchDatabaseName,
  type RunLock,
  type TestDatabaseConfig,
} from './test-database.js';

/**
 * One vitest run per checkout, enforced rather than asked for.
 *
 * `provisionTestDatabase` already says the brief for this repository is not to
 * run two suites at once, and until now nothing stopped it. The scratch
 * database is named from the checkout path and the worker's pool id, and
 * `VITEST_POOL_ID` restarts at 1 for every invocation — so a targeted test run
 * started while a full suite is going uses the SAME databases, and
 * `resetDatabase`'s `TRUNCATE ... CASCADE` empties tables the other run is
 * mid-test on.
 *
 * What that looks like from the outside is dozens of unrelated tests failing on
 * five-second transaction timeouts, with nothing naming the cause. It cost a
 * day of misdiagnosis before the lock waits in `pg_stat_activity` gave it away.
 *
 * An ADVISORY lock, and session-scoped on purpose: a killed run drops its
 * connection and the lock goes with it. A row in a table would survive the kill
 * and lock the checkout out until somebody deleted it by hand.
 */
const held: RunLock[] = [];

afterEach(async () => {
  await Promise.all(held.splice(0).map((lock) => lock.release()));
});

/**
 * The config the GLOBAL SETUP would build, not the one a worker sees.
 *
 * Inside a worker `DATABASE_URL` is already rewritten to that worker's scratch
 * database, so `testDatabaseConfig()` takes its "the operator chose this"
 * branch and reports `name: null` — which the lock correctly declines to guard.
 * The lock is taken in the main process, before any worker exists, so the test
 * has to describe that situation rather than the one it is running in.
 *
 * A name of its own (`_locktest`) so this never contends with the lock the real
 * run is holding around it.
 */
const config = (): TestDatabaseConfig => ({
  name: `${scratchDatabaseName(repoRoot)}_locktest`,
  appUrl: '',
  superuserUrl: process.env.SUPERUSER_DATABASE_URL ?? null,
});

async function take(): Promise<RunLock> {
  const lock = await acquireRunLock(config());
  expect(lock, 'SUPERUSER_DATABASE_URL must be set for this test').not.toBeNull();
  held.push(lock!);
  return lock!;
}

describe('acquireRunLock', () => {
  it('refuses a second holder while the first has it', async () => {
    await take();

    await expect(acquireRunLock(config())).rejects.toThrow(
      /already in use/i,
    );
  });

  it('names the database and what to do about it', async () => {
    await take();

    // The message is the whole point of the feature. A refusal that does not
    // say which database, or that the two runs would truncate each other,
    // leaves the reader exactly where the silent version did.
    await expect(acquireRunLock(config())).rejects.toThrow(
      /syntra_test_[0-9a-f]+/,
    );
    await expect(acquireRunLock(config())).rejects.toThrow(
      /worktree|wait/i,
    );
  });

  it('hands the lock back when the holder releases it', async () => {
    const first = await take();
    await first.release();
    held.length = 0;

    // Releasable and re-takeable, so a finished run does not lock the next one
    // out of the checkout.
    const second = await acquireRunLock(config());
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('guards nothing when the operator chose the database', async () => {
    // An exported DATABASE_URL means somebody pointed the suite somewhere
    // deliberately — CI, or a developer. Provisioning is not ours there and
    // neither is deciding how many runs may share it.
    const chosen = { name: null, appUrl: 'postgres://x/y', superuserUrl: null };
    expect(await acquireRunLock(chosen)).toBeNull();
  });
});
