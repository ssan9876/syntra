import type { PgTools } from './postgres.js';
import { BackupRefusedError, type BackupStore } from './store.js';

/**
 * A restore test: the backup restored into a scratch database in the same
 * server, its tables and rows counted, and the database dropped. The live
 * database is never touched, which is what makes it safe to run on a timer.
 *
 * This is the question `ops/syntra-backup verify` asks, and the one a backup
 * schedule nobody checks never does: a truncated or corrupt archive still
 * starts with PGDMP and still lists its tables.
 */
export interface VerifyContext {
  store: BackupStore;
  /** Connected to the live database, to create and drop the scratch one. */
  admin: PgTools;
  /** Client tools for another database on the same server. */
  toolsFor(database: string): PgTools;
  step(message: string): void;
  now?(): Date;
}

export interface VerifyOutcome {
  name: string;
  tables: number;
  rows: number;
}

export async function verifyBackup(name: string, ctx: VerifyContext): Promise<VerifyOutcome> {
  const backup = await ctx.store.get(name);
  if (!backup) throw new BackupRefusedError(`No backup named ${name}.`);
  const now = ctx.now ?? (() => new Date());
  const scratch = `syntra_verify_${now().getTime()}`;

  ctx.step(`Restoring ${name} into a scratch database`);
  await ctx.admin.sql(`CREATE DATABASE "${scratch}";`);
  try {
    const pg = ctx.toolsFor(scratch);
    await pg.restore(ctx.store.dumpPath(name));
    ctx.step('Counting what arrived');
    const counts = (await pg.sql(
      `ANALYZE; SELECT count(*) || ' ' || COALESCE(SUM(n_live_tup), 0) FROM pg_stat_user_tables;`,
    )).trim().split(/\s+/);
    const tables = Number(counts[0] ?? 0);
    const rows = Number(counts[1] ?? 0);
    if (!tables || !rows) {
      throw new BackupRefusedError(`${name} restored ${tables ? `${tables} tables and no rows` : 'no tables'}.`);
    }
    await ctx.store.markVerified(name, { at: now(), tables, rows });
    return { name, tables, rows };
  } finally {
    await ctx.admin.sql(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE);`).catch(() => undefined);
  }
}
