import { Client } from 'pg';
import { prisma } from './client.js';

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
  const client = new Client({ connectionString: url });
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
