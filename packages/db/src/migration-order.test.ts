import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_MIGRATIONS,
  MIGRATION_NAME_FLOOR,
  migrationsBelowFloor,
} from './migration-order.js';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/migrations');

const directories = (): string[] =>
  readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

describe('migration naming order', () => {
  /**
   * The hazard, stated once.
   *
   * Six migrations are hand-named with dates AHEAD of the real clock
   * (20260825.. through 20260830..), and the lab has applied them. A new
   * migration generated today gets a real timestamp -- 20260824.. -- which
   * sorts BEFORE them, while being diffed against a shadow database that
   * holds the full end state including their columns.
   *
   * `prisma migrate deploy` replays in NAME order on a fresh database, so
   * such a migration runs before the state it was written against exists.
   * `migrationState()` compares name SETS, not order, so nothing else in
   * this codebase can see the difference.
   */
  it('has no migration at or below the floor that is not grandfathered', () => {
    expect(migrationsBelowFloor(directories(), MIGRATION_NAME_FLOOR)).toEqual([]);
  });

  it('flags a newly generated real-timestamp migration', () => {
    expect(
      migrationsBelowFloor([...directories(), '20260824235959_add_a_column'], MIGRATION_NAME_FLOOR),
    ).toEqual(['20260824235959_add_a_column']);
  });

  it('accepts one named above the floor', () => {
    expect(
      migrationsBelowFloor([...directories(), '20260929000000_add_a_column'], MIGRATION_NAME_FLOOR),
    ).toEqual([]);
  });

  /**
   * The grandfather list must describe the tree it ships with, or the check
   * silently stops covering whatever drifted out of it.
   */
  it('grandfathers exactly the migrations that exist', () => {
    expect([...KNOWN_MIGRATIONS].sort()).toEqual(directories());
  });
});
