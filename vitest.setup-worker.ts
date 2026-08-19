/**
 * Points this worker at its own database, before anything can connect.
 *
 * `packages/db/src/client.ts` is `new PrismaClient()` with no arguments, so the
 * connection string is read from `process.env.DATABASE_URL` **at module import
 * time**. Vitest imports its `setupFiles` before the test module — and
 * therefore before the client — which is what makes this the right seam and
 * `test.env` the wrong one: `test.env` is computed once in the config, in the
 * parent process, and is identical in every worker by construction.
 *
 * Why per-worker databases at all: `resetDatabase()` issues
 * `TRUNCATE ... CASCADE` over every table. Two workers on one database do not
 * merely race for rows, they delete each other's fixtures in the middle of a
 * test, and the resulting failures name no assertion and point nowhere near
 * the code being changed. That is why the suite ran `singleFork: true` and took
 * 116 minutes, and why a `--filter` was dangerous rather than convenient:
 * scoping which tests EXECUTE never scoped which tables got truncated.
 *
 * **The base name arrives in the environment rather than being re-derived**,
 * and that is load-bearing. `testDatabaseConfig()` treats a set `DATABASE_URL`
 * as "the operator chose this database, provisioning is not ours" — and
 * `test.env` has already set one by the time this file runs, so calling it here
 * would take that branch every time and this override would never fire. The
 * config knows the truth because it read it before any of that; it passes it
 * on. Absent means the operator really did choose the database, and this file
 * leaves it exactly as it found it.
 *
 * `SUPERUSER_DATABASE_URL` is deliberately untouched. `test-support.ts`'s
 * `superuserUrlForCurrentDatabase` takes its database name from
 * `process.env.DATABASE_URL` and only its credentials and host from the
 * superuser URL, so the tamper tests follow this worker with no edit at all.
 * Its docstring anticipated this: "Parallel agents each run against a scratch
 * database".
 */
const base = process.env.SYNTRA_TEST_DB_BASE;

if (base !== undefined && base !== '') {
  // Vitest sets this per worker, 1-based, in both the `forks` and `threads`
  // pools. Absent means one worker, and shard 1 is the honest answer.
  const parsed = Number.parseInt(process.env.VITEST_POOL_ID ?? '1', 10);
  const shard = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;

  const url = new URL(process.env.DATABASE_URL ?? '');
  url.pathname = `/${base}_w${shard}`;

  // A pool per worker, bounded, because they all share one PostgreSQL.
  //
  // Prisma's default pool is `physical cores * 2 + 1` -- 33 on this machine --
  // and eight of those is 264 against a server whose `max_connections` is 100
  // with 3 reserved for superusers. The suite would run for half an hour and
  // then start failing with "too many clients already", nowhere near whatever
  // was being changed.
  //
  // Five is generous for what a worker actually does: one `withTenant`
  // transaction at a time, plus the occasional short-lived `pg` client in
  // `asDatabaseSuperuser`. Eight workers therefore hold at most 40, leaving
  // the rest for a developer's API process and for pg-boss.
  url.searchParams.set('connection_limit', '5');

  process.env.DATABASE_URL = url.toString();
}
