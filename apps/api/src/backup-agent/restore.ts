import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { versionVerdict } from '@syntra/core';
import type { PgTools } from './postgres.js';
import { BackupRefusedError, type BackupStore, type StoredBackup } from './store.js';

/**
 * Putting a backup back while the API keeps running.
 *
 * The API is never stopped: the agent has no Docker socket and no Kubernetes
 * rights, and does not need them. Instead:
 *
 *   1. A safety backup of the current state, so the restore can be undone.
 *   2. A hold written into the CURRENT database. Every API process notices a
 *      hold it has not seen within seconds and restarts, coming back held: no
 *      scheduler, no writes to target systems.
 *   3. The application role is locked out (NOLOGIN) and its connections
 *      ended, so nothing writes into the database while it is replaced.
 *   4. Every schema dropped, `public` recreated for the application role, the
 *      dump restored, and rows counted.
 *   5. A hold written into the RESTORED database (ops/restore-hold.sql).
 *   6. The role let back in, and migrations applied by the agent itself.
 *
 * The API processes then see the restored hold, which is not the one they
 * started with, and restart once more: an OIDC provider cached before the
 * restore would otherwise survive it, because the restored generation counter
 * is lower than the cached one.
 *
 * If step 4 or 5 fails, the safety backup is restored the same way. If that
 * fails too, the role stays locked out and the step says what to restore by
 * hand: an API serving an empty or half-restored database is worse than one
 * that cannot connect.
 */
export interface RestoreContext {
  pg: PgTools;
  store: BackupStore;
  /** The role the API connects as, from DATABASE_URL. */
  appRole: string;
  /** The role this agent connects as. Must differ from appRole. */
  superRole: string;
  version: string;
  fingerprint: string | null;
  database: string;
  /** `prisma migrate deploy` as the application role. */
  migrate(): Promise<void>;
  /** How long to give API processes to notice the first hold and restart. */
  settleMs?: number;
  sleep?(ms: number): Promise<void>;
  step(message: string): void;
}

export interface RestoreOutcome {
  restored: string;
  /** Null when the current database held nothing worth keeping. */
  safety: string | null;
  rolledBack: boolean;
  message: string;
}

const HOLD_SQL_PATH = fileURLToPath(new URL('../../../../ops/restore-hold.sql', import.meta.url));

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

export async function restoreBackup(name: string, ctx: RestoreContext): Promise<RestoreOutcome> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (ctx.appRole === ctx.superRole) {
    throw new BackupRefusedError(
      'DATABASE_URL and SUPERUSER_DATABASE_URL use the same role, so the API cannot be kept out during a restore.',
    );
  }

  const backup = await ctx.store.get(name);
  if (!backup) throw new BackupRefusedError(`No backup named ${name}.`);
  if (versionVerdict(backup.version, ctx.version) === 'newer') {
    throw new BackupRefusedError(
      `${name} was taken on ${backup.version} and this install runs ${ctx.version}. Update to ${backup.version} or later, then restore.`,
    );
  }
  const file = ctx.store.dumpPath(name);
  if ((await ctx.pg.tableDataSections(file)) === 0) {
    throw new BackupRefusedError(`${name} contains no table data; it is not a backup.`);
  }

  ctx.step('Backing up the current state');
  let safety: StoredBackup | null;
  try {
    safety = await ctx.store.create('pre-restore', {
      version: ctx.version,
      fingerprint: ctx.fingerprint,
      database: ctx.database,
    });
  } catch (cause) {
    // An empty database -- a new server, or the one being recovered -- has
    // nothing to keep, and refusing to restore over it would refuse the
    // restore that matters most.
    if (!(cause instanceof BackupRefusedError) || !/no table data|empty/.test(cause.message)) throw cause;
    ctx.step('Current database is empty; no safety backup taken');
    safety = null;
  }

  ctx.step('Pausing the API');
  // The same SQL as the restored hold below: it creates the table when the
  // current database predates it, or has nothing in it at all.
  await ctx.pg.sql(await readFile(HOLD_SQL_PATH, 'utf8'), { backup_name: name, app_role: ctx.appRole });
  await sleep(ctx.settleMs ?? 20_000);

  ctx.step('Disconnecting the API');
  await lockOut(ctx);

  try {
    await replaceWith(backup, file, ctx);
  } catch (cause) {
    const reason = (cause instanceof Error ? cause.message : String(cause)).replace(/\.$/, '');
    if (!safety) {
      throw new BackupRefusedError(
        `Restore of ${name} failed (${reason}). The database was empty before, and the API is locked out of it.`,
      );
    }
    ctx.step(`Restore failed; putting ${safety.name} back`);
    try {
      await replaceWith(safety, ctx.store.dumpPath(safety.name), ctx);
    } catch (rollbackCause) {
      const rollback = rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause);
      throw new BackupRefusedError(
        `Restore of ${name} failed (${reason}), and ${safety.name} could not be put back (${rollback}). ` +
          `The API is locked out of the database. Restore ${safety.name} by hand.`,
      );
    }
    await letIn(ctx);
    return {
      restored: safety.name,
      safety: safety.name,
      rolledBack: true,
      message: `Restore of ${name} failed: ${reason}. ${safety.name} was put back.`,
    };
  }

  await letIn(ctx);
  return { restored: name, safety: safety?.name ?? null, rolledBack: false, message: `Restored ${name}.` };
}

async function lockOut(ctx: RestoreContext): Promise<void> {
  await ctx.pg.sql(`ALTER ROLE ${ident(ctx.appRole)} NOLOGIN;`);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 30; attempt++) {
    const remaining = await ctx.pg.sql(
      `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = ${literal(ctx.appRole)} AND pid <> pg_backend_pid();`,
    );
    if (Number(remaining.trim() || '0') === 0) return;
    await sleep(500);
  }
  throw new BackupRefusedError(`Connections as ${ctx.appRole} did not end.`);
}

async function replaceWith(backup: StoredBackup, file: string, ctx: RestoreContext): Promise<void> {
  ctx.step('Loading the backup into the database');
  // Every non-system schema, not only `public`: pg-boss keeps its queue in
  // its own. And `public` belongs to the application role, which owns every
  // table, as infra/initdb/01-app-role.sh sets it up.
  await ctx.pg.sql(`
DO $$
DECLARE s text;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s);
  END LOOP;
END $$;
CREATE SCHEMA public;
ALTER SCHEMA public OWNER TO ${ident(ctx.appRole)};
GRANT ALL ON SCHEMA public TO ${ident(ctx.appRole)};
`);
  await ctx.pg.restore(file);

  const counts = (await ctx.pg.sql(
    `ANALYZE; SELECT count(*) || ' ' || COALESCE(SUM(n_live_tup), 0) FROM pg_stat_user_tables;`,
  )).trim().split(/\s+/);
  const tables = Number(counts[0] ?? 0);
  const rows = Number(counts[1] ?? 0);
  if (!tables || !rows) throw new BackupRefusedError(`${backup.name} restored ${tables ? `${tables} tables and no rows` : 'no tables'}.`);

  ctx.step('Pausing background work in the restored data');
  await ctx.pg.sql(await readFile(HOLD_SQL_PATH, 'utf8'), {
    backup_name: backup.name,
    app_role: ctx.appRole,
  });
  await ctx.pg.sql(
    `UPDATE "RestoreHold" SET "backupTakenAt" = ${literal(backup.createdAt)}::timestamptz, "backupVersion" = ${
      backup.version === 'unknown' ? 'NULL' : literal(backup.version)
    } WHERE "backupName" = ${literal(backup.name)} AND "releasedAt" IS NULL;`,
  );
}

async function letIn(ctx: RestoreContext): Promise<void> {
  await ctx.pg.sql(`ALTER ROLE ${ident(ctx.appRole)} LOGIN;`);
  ctx.step('Applying migrations');
  await ctx.migrate();
}
