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
  provisionTestDatabase,
  repoRoot,
  testDatabaseConfig,
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

export default async function setup(): Promise<void> {
  const config = testDatabaseConfig();
  if (config.name === null) return;

  await provisionTestDatabase(config);

  // `migrate deploy` and nothing else: it never diffs, never needs a shadow
  // database, and never prompts. Run every time rather than only after
  // creation, so a scratch database left over from an older branch picks up
  // the migrations that branch did not have.
  execFileSync(process.execPath, [prismaCli(), 'migrate', 'deploy'], {
    cwd: resolve(repoRoot, 'packages/db'),
    env: { ...process.env, DATABASE_URL: config.appUrl },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
