import { Client } from 'pg';
import { prisma } from './client.js';

/**
 * Points the superuser connection at whichever database the tests are actually
 * using.
 *
 * `SUPERUSER_DATABASE_URL` names a database of its own, and it is read
 * independently of `DATABASE_URL`. Parallel agents each run against a scratch
 * database, so without this the tamper `UPDATE` lands in the *original*
 * database while the chain under test sits in the scratch one — the chain is
 * never broken, the test reports that tampering was detected, and it has
 * proved nothing at all. A test that passes for the wrong reason is worse than
 * one that fails, and this one guards the audit log.
 *
 * Credentials and host come from the superuser URL; the database name comes
 * from the URL the application is using.
 */
function superuserUrlForCurrentDatabase(superuserUrl: string): string {
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) return superuserUrl;
  const su = new URL(superuserUrl);
  su.pathname = new URL(appUrl).pathname;
  return su.toString();
}

/**
 * Runs SQL as a database superuser, bypassing row-level security and the
 * append-only rules.
 *
 * This exists for exactly one purpose: simulating an attacker who has direct
 * database access. That is the threat the audit hash chain is designed to
 * detect, and a test that tampers through the application role proves nothing,
 * because RLS silently matches no rows. Never use this outside a test that is
 * deliberately modelling database-level compromise.
 */
export async function asDatabaseSuperuser(
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  const url = process.env.SUPERUSER_DATABASE_URL;
  if (!url) {
    throw new Error(
      'SUPERUSER_DATABASE_URL is not set; tamper-detection tests cannot run',
    );
  }
  const client = new Client({ connectionString: superuserUrlForCurrentDatabase(url) });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** Truncates every table except Prisma's migration bookkeeping. */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
  `;
  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}
