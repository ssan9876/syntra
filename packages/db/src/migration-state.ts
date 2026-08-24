import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from './client.js';

/**
 * Whether the schema this process expects is the schema the database has.
 *
 * Here rather than in `@syntra/core` because this package owns
 * `prisma/migrations`, and a reader that had to be told where that directory
 * is would be a reader that goes wrong the first time the layout moves.
 *
 * The question matters because **the API starts perfectly happily against a
 * half-migrated database.** Prisma does not check on connect; the first query
 * touching a missing column fails, which may be an hour later and on one route
 * only. That is the characteristic shape of a bad update, and it is invisible
 * to anything that merely asks whether the process is listening.
 */

export interface MigrationState {
  ok: boolean;
  applied: number;
  /** On disk, never applied. The schema is behind the code. */
  pending: string[];
  /**
   * Started and never finished, or rolled back. Worse than pending: a pending
   * migration has not run, while a failed one ran PARTLY, and the tables it
   * touched are in a state no migration describes.
   */
  failed: string[];
  /**
   * Applied to the database but absent from disk. The code is BEHIND the
   * schema -- which is what a rollback to an older release looks like, and is
   * reported rather than treated as fine: the older code may not know about a
   * column that is now NOT NULL.
   */
  unknown: string[];
}

/** The migration directories shipped with this build. */
export function migrationNamesOnDisk(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> package root -> prisma/migrations
  const dir = join(here, '..', 'prisma', 'migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export async function migrationState(): Promise<MigrationState> {
  const onDisk = migrationNamesOnDisk();

  // Raw, because `_prisma_migrations` is Prisma's own bookkeeping table and is
  // deliberately absent from the generated client.
  const rows = await prisma.$queryRawUnsafe<MigrationRow[]>(
    'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"',
  );

  const failed = rows
    .filter((row) => row.rolled_back_at !== null || row.finished_at === null)
    .map((row) => row.migration_name)
    .sort();

  const applied = new Set(
    rows
      .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
      .map((row) => row.migration_name),
  );

  const pending = onDisk.filter((name) => !applied.has(name));
  const unknown = [...applied].filter((name) => !onDisk.includes(name)).sort();

  return {
    // `unknown` is reported but does NOT make this unhealthy. It is the
    // expected state immediately after a rollback to an older release, and a
    // rollback that reported itself unhealthy would roll itself back again.
    ok: pending.length === 0 && failed.length === 0,
    applied: applied.size,
    pending,
    failed,
    unknown,
  };
}
