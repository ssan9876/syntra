/**
 * Provisions the suite's own database before the first test file loads.
 *
 * See `packages/db/src/test-database.ts` for why the suite does not share the
 * database `.env` names. This runs once per `vitest` invocation, in the main
 * process, before any worker is forked — `migrate deploy` is idempotent, so
 * the second run against an existing scratch database is a no-op and costs
 * about a second.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  acquireRunLock,
  provisionTestDatabase,
  repoRoot,
  testDatabaseConfig,
  testWorkerCount,
} from './packages/db/src/test-database.js';

/**
 * Prisma's CLI, run through `node` rather than through `npx`.
 *
 * `npx` is a `.cmd` shim on Windows and `execFileSync` refuses to spawn one
 * without a shell (EINVAL); going through a shell would then need the
 * arguments quoted for two different shells. Resolving the package's own entry
 * point avoids both, and pins the CLI to the version this workspace installed
 * rather than whatever `npx` would decide to fetch.
 */
function prismaCli(): string {
  const require = createRequire(resolve(repoRoot, 'packages/db/package.json'));
  const manifest = require.resolve('prisma/package.json');
  return resolve(dirname(manifest), 'build/index.js');
}

export default async function setup(): Promise<() => Promise<void>> {
  // Nothing to provision when the operator chose the database.
  if (testDatabaseConfig().name === null) return async () => {};

  // BEFORE anything is provisioned or migrated. A second run in this checkout
  // would use the same scratch databases -- `VITEST_POOL_ID` restarts at 1 per
  // invocation -- and `resetDatabase`'s TRUNCATE would empty tables the first
  // run is mid-test on. Failing here, with a sentence naming the database,
  // replaces a day of unrelated five-second timeouts.
  //
  // Throwing out of global setup aborts the run before a worker is forked,
  // which is the whole point: nothing has touched a database yet.
  const lock = await acquireRunLock(testDatabaseConfig(1));

  // ONE database per worker, and the count comes from the same function
  // `vitest.config.ts` pins `minForks`/`maxForks` to. If these two ever
  // disagreed, some worker would share a database with another and truncate it
  // mid-test -- the failure mode that made this suite serial in the first
  // place. There is deliberately no second place to change the number.
  const shards = testWorkerCount();

  for (let shard = 1; shard <= shards; shard += 1) {
    const config = testDatabaseConfig(shard);
    await provisionTestDatabase(config);

    // `migrate deploy` and nothing else: it never diffs, never needs a shadow
    // database, and never prompts. Run every time rather than only after
    // creation, so a scratch database left over from an older branch picks up
    // the migrations that branch did not have.
    //
    // Sequential rather than concurrent: `prisma migrate deploy` takes an
    // advisory lock per database, but they all contend for the same server on
    // first run, and a second or two per shard once is not worth the risk of
    // interleaving CREATE DATABASE with a migration.
    execFileSync(process.execPath, [prismaCli(), 'migrate', 'deploy'], {
      cwd: resolve(repoRoot, 'packages/db'),
      env: { ...process.env, DATABASE_URL: config.appUrl },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }

  // Vitest calls this after the last worker exits. The lock would go anyway
  // when the process ends and the connection drops -- that is why it is
  // advisory -- but releasing it deliberately keeps a watch-mode session from
  // holding the checkout for as long as it is open.
  return async () => {
    await lock?.release();
  };
}
