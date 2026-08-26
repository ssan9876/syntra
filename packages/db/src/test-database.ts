/**
 * Where the test suite's database lives, and how it comes into existence.
 *
 * The suite truncates every table between cases. Pointed at the development
 * database that `.env` names, a second checkout of this repository on the same
 * machine — or a developer with the API running — shares those truncations and
 * the row locks they take. The symptom is not a clear one: about twenty-eight
 * tests fail at once, all of them reading `expected 500 to be 200`, none of
 * them near the code that is actually being changed. That has cost this
 * project a day twice.
 *
 * So the suite gets a database of its own, named after the checkout it belongs
 * to, created and migrated before the first test file loads. Two checkouts get
 * two databases and never meet. Nothing here runs against `syntra` unless a
 * caller sets `DATABASE_URL` in the environment on purpose, which is the CI
 * shape and is deliberately left alone.
 *
 * Imported by `vitest.config.ts` and by `vitest.global-setup.ts`, so both
 * agree on the name without passing it between processes. It must therefore
 * import nothing but Node builtins and `pg`: pulling in `./client.js` here
 * would construct a `PrismaClient` before `DATABASE_URL` had been rewritten,
 * and every test would run against whatever `.env` said.
 */
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, from this file's location rather than from `cwd`. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface TestDatabaseConfig {
  /** Null when the caller supplied `DATABASE_URL` and owns provisioning. */
  name: string | null;
  /** What the tests connect as: `syntra_app`, NOSUPERUSER, NOBYPASSRLS. */
  appUrl: string;
  /**
   * The superuser connection, pointed at the same database. Tamper-detection
   * tests need it, and so does creating the database in the first place.
   */
  superuserUrl: string | null;
}

/**
 * Reads `.env` and returns it, deliberately WITHOUT touching `process.env`.
 *
 * Vitest does not load `.env` files; Prisma's client does, at import time,
 * which is how the suite has been getting `DATABASE_URL` at all. That is too
 * late for us — the name has to be known before any test module is loaded.
 *
 * Not writing to `process.env` is the load-bearing part. This function is
 * called twice in one process, once from `vitest.config.ts` and once from the
 * global setup, and a version that exported into the environment would make
 * the second call see the first call's values and conclude that the operator
 * had chosen a database explicitly — which is exactly the branch that turns
 * provisioning off.
 */
function readDotEnv(): Record<string, string> {
  const file = resolve(repoRoot, '.env');
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** Swaps the database name in a PostgreSQL URL, leaving everything else. */
function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * The scratch database's name: stable for one checkout, different for another.
 *
 * The hash is of the absolute path, so two clones under different directories
 * never collide, and re-running the suite in the same clone reuses the
 * database rather than paying for a migration run every time.
 */
export function scratchDatabaseName(root: string = repoRoot, shard?: number): string {
  const digest = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
  // Unsuffixed when there is no shard, so a single-worker run keeps the name
  // it has always had and does not orphan the database an existing checkout
  // already migrated.
  return shard === undefined ? `syntra_test_${digest}` : `syntra_test_${digest}_w${shard}`;
}

/**
 * How many workers the suite runs, and therefore how many databases it needs.
 *
 * The two numbers are the same number on purpose. Every worker truncates every
 * table in the database it is pointed at, so two workers sharing one database
 * do not merely race -- they delete each other's fixtures mid-test, and the
 * failures that produces name no assertion and point nowhere near the code
 * being changed. This project has lost days to that three times, most
 * memorably a run of 116 failures containing not one assertion.
 *
 * So the shard count is computed ONCE, here, and both `vitest.config.ts`
 * (which pins `minForks`/`maxForks` to it) and the global setup (which
 * provisions that many databases) read it from this function. A drift between
 * them is exactly the failure above, so there is no second place to change.
 *
 * `SYNTRA_TEST_WORKERS` overrides it, for bisecting a suspected ordering
 * dependency by forcing 1.
 */
export function testWorkerCount(): number {
  const override = Number.parseInt(process.env.SYNTRA_TEST_WORKERS ?? '', 10);
  if (Number.isInteger(override) && override > 0) return override;
  // Leave a core for the PostgreSQL server and this process. Every worker is
  // I/O-bound on that one server, so more workers than cores buys nothing and
  // lengthens the truncation queue.
  const cores = cpus().length;
  return Math.max(1, Math.min(8, cores - 1));
}

export function testDatabaseConfig(shard?: number): TestDatabaseConfig {
  const dotEnv = readDotEnv();
  // An exported DATABASE_URL means the caller chose a database — CI, or a
  // developer pointing the suite somewhere on purpose — and provisioning is
  // not ours to do. `.env` is not that: it names the development database
  // every checkout on the machine shares.
  const explicit = process.env.DATABASE_URL ?? null;
  const superuser = process.env.SUPERUSER_DATABASE_URL ?? dotEnv.SUPERUSER_DATABASE_URL ?? null;

  if (explicit !== null) {
    const chosen = new URL(explicit).pathname.slice(1);
    return {
      name: null,
      appUrl: explicit,
      superuserUrl: superuser ? withDatabase(superuser, chosen) : null,
    };
  }

  const base = dotEnv.DATABASE_URL;
  if (!base) {
    throw new Error(
      'No DATABASE_URL: set one in the environment or in .env before running the tests.',
    );
  }

  const name = scratchDatabaseName(repoRoot, shard);
  return {
    name,
    appUrl: withDatabase(base, name),
    superuserUrl: superuser ? withDatabase(superuser, name) : null,
  };
}

/**
 * Creates the scratch database if it is not there, and migrates it.
 *
 * Owned by `syntra_app`, which is what makes the row-level security model
 * testable: that role is NOSUPERUSER and NOBYPASSRLS, so `FORCE ROW LEVEL
 * SECURITY` applies to it even though it owns the tables. Granting CREATE on
 * the database matches `infra/initdb/01-app-role.sql` — pg-boss creates a
 * schema of its own on first start.
 *
 * `CREATE DATABASE` cannot run inside a transaction and has no `IF NOT
 * EXISTS`, so existence is checked first. Two suites racing to create the same
 * database is not a case worth handling: they would be the same checkout, and
 * the brief for this repository says not to run two at once.
 */
export async function provisionTestDatabase(
  config: TestDatabaseConfig,
): Promise<{ created: boolean }> {
  if (config.name === null) return { created: false };
  if (!config.superuserUrl) {
    throw new Error(
      'SUPERUSER_DATABASE_URL is not set; the test database cannot be created. ' +
        'Set it in .env, or export DATABASE_URL to point the suite at a database you provisioned.',
    );
  }

  const { Client } = await import('pg');
  const maintenance = new Client({
    connectionString: withDatabase(config.superuserUrl, 'postgres'),
  });
  await maintenance.connect();
  let created = false;
  try {
    const existing = await maintenance.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [config.name],
    );
    if (existing.rowCount === 0) {
      // The name is derived from a SHA-256 digest, so it cannot carry an
      // identifier-breaking character; quoted anyway, because an identifier
      // cannot be a bind parameter and the next person may change the recipe.
      await maintenance.query(
        `CREATE DATABASE "${config.name}" OWNER ${'syntra_app'}`,
      );
      await maintenance.query(
        `GRANT CREATE ON DATABASE "${config.name}" TO ${'syntra_app'}`,
      );
      created = true;
    }
  } finally {
    await maintenance.end();
  }

  if (created) {
    // The `public` schema belongs to `pg_database_owner` on PostgreSQL 15 and
    // later, which is not the same thing as the database's owner being able to
    // create in it under every configuration. Setting it explicitly matches
    // what `infra/initdb` does to the development database.
    const inside = new Client({ connectionString: config.superuserUrl });
    await inside.connect();
    try {
      await inside.query('ALTER SCHEMA public OWNER TO syntra_app');
      await inside.query('GRANT ALL ON SCHEMA public TO syntra_app');
    } finally {
      await inside.end();
    }
  }

  return { created };
}

/** Held for the lifetime of one vitest invocation. Released on teardown. */
export interface RunLock {
  release(): Promise<void>;
}

/**
 * A PostgreSQL advisory key derived from the scratch database's name.
 *
 * 60 bits of the digest, so the value is comfortably inside a signed bigint and
 * cannot come out negative. Two checkouts hash to different keys and never
 * contend; the same checkout always produces the same key, which is the whole
 * point.
 */
function advisoryKey(name: string): string {
  return BigInt(`0x${createHash('sha256').update(name).digest('hex').slice(0, 15)}`).toString();
}

/**
 * Refuses a second vitest run against the same checkout's scratch databases.
 *
 * `provisionTestDatabase` says above that the brief for this repository is not
 * to run two suites at once. Nothing enforced it, and the failure when somebody
 * does is both severe and unrecognisable: the database name is
 * `syntra_test_<checkout digest>_w<VITEST_POOL_ID>`, and `VITEST_POOL_ID`
 * restarts at 1 for every invocation — so a targeted run started while a full
 * suite is going lands on the SAME databases, and `resetDatabase`'s
 * `TRUNCATE ... CASCADE` empties tables the other run is mid-test on.
 *
 * What that looks like is dozens of unrelated tests timing out five seconds
 * into a transaction, nowhere near whatever is being changed, with the real
 * cause visible only as lock waits in `pg_stat_activity`. This module's own
 * header says that shape has cost the project a day twice; this is the third.
 *
 * ADVISORY rather than a row, and session-scoped: a killed run drops its
 * connection and PostgreSQL drops the lock with it. A table row would outlive
 * the kill and lock the checkout out until somebody deleted it by hand — trading
 * a confusing failure for a stuck one.
 *
 * Answers `null`, and guards nothing, when the operator chose the database. An
 * exported `DATABASE_URL` is CI or a deliberate choice, and how many runs may
 * share it is not this function's decision.
 */
export async function acquireRunLock(
  config: TestDatabaseConfig,
): Promise<RunLock | null> {
  if (config.name === null) return null;
  if (!config.superuserUrl) return null;

  const { Client } = await import('pg');
  const client = new Client({
    connectionString: withDatabase(config.superuserUrl, 'postgres'),
  });
  await client.connect();

  // `try`, never the blocking form. Waiting would turn "you started two runs"
  // into "the second one hangs forever", which is a worse version of the
  // problem this exists to remove.
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [advisoryKey(config.name)],
  );

  if (!rows[0]?.locked) {
    await client.end();
    throw new Error(
      `${config.name} is already in use by another vitest run in this checkout.\n` +
        'Concurrent runs share scratch databases and truncate each other mid-test, ' +
        'which surfaces as unrelated tests timing out.\n' +
        'Wait for the other run to finish, or run from a separate git worktree.',
    );
  }

  return {
    async release() {
      // Ending the connection releases the lock on its own; unlocking first
      // makes that explicit rather than incidental.
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [
          advisoryKey(config.name!),
        ]);
      } finally {
        await client.end();
      }
    },
  };
}
