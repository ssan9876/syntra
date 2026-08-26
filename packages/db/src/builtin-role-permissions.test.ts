import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@syntra/core';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260903000000_builtin_role_permissions/migration.sql',
);

const sql = readFileSync(MIGRATION, 'utf8');

/**
 * Runs the migration's SQL somewhere it can actually see rows.
 *
 * `prisma.$executeRawUnsafe` on the bare client runs as the application role
 * with no `app.current_tenant` set, and every table here is under row-level
 * security -- so the UPDATE matches nothing, reports success, and a test built
 * on it passes while proving nothing at all. The real migration runs as the
 * migration role, which is not subject to RLS; binding a tenant is how a test
 * reaches the same rows.
 */
const applyMigration = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.$executeRawUnsafe(sql));

/** The quoted strings inside the migration's ARRAY[...] literal. */
const backfilled = (): string[] =>
  [...(sql.match(/ARRAY\[([\s\S]*?)\]::text\[\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (m) => m[1]!,
  );

describe('the built-in role backfill', () => {
  /**
   * The literal list is a SNAPSHOT of the catalogue at the moment this
   * migration was written, and it has to stay one: a name in here that the
   * catalogue does not have is a typo that grants a meaningless string
   * forever, and `hasPermission` compares by exact match so nobody would ever
   * see it fail.
   *
   * Deliberately a SUBSET assertion and not an equality one. Once the role API
   * exists the catalogue is meant to grow without a migration behind it --
   * an administrator grants the new permission from the console -- so demanding
   * a new migration per permission would be demanding the exact ceremony this
   * work removed.
   */
  it('names only permissions the catalogue has', () => {
    const catalog = new Set<string>(ALL_PERMISSIONS);
    expect(backfilled().filter((p) => !catalog.has(p))).toEqual([]);
  });

  /**
   * U3, named. `deployment.manage` was added to the catalogue after every
   * existing deployment had been seeded, so the Updates page was hidden and
   * every update route answered 403 -- on the one feature whose whole point is
   * repairing a deployment.
   */
  it('includes deployment.manage', () => {
    expect(backfilled()).toContain('deployment.manage');
  });

  /** Whatever the catalogue held when this was written, all of it. */
  it('is the full catalogue as of the migration', () => {
    expect(backfilled().length).toBeGreaterThanOrEqual(20);
  });

  /**
   * ADDITIVE ONLY. A built-in role that an administrator has deliberately
   * narrowed must not be widened back on the next deploy, and no role may lose
   * anything: this migration repairs an omission, it does not enforce a
   * policy.
   */
  it('only ever adds, and only to built-in roles', () => {
    expect(sql).toMatch(/"builtIn"\s*=\s*true/);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+"Role"/i);
  });
});

/**
 * The migration doing its job, against a database.
 *
 * The plan rehearsed this by hand: reset the development database, seed it,
 * narrow the Owner role with `prisma db execute`, re-apply the migration and
 * look. That is the right check and the wrong place to run it -- the
 * development database is shared, and a reset takes whatever else is using it
 * down with it. The same proof runs here against the per-worker test database,
 * where it also runs again on every future change rather than once, by hand,
 * on the day it was written.
 */
describe('what the backfill does to rows', () => {
  let tenantId: string;

  beforeEach(async () => {
    await resetDatabase();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = tenant.id;
  });

  it('restores a built-in role frozen at an older catalogue, and leaves a custom one alone', async () => {
    await withTenant(tenantId, async (tx) => {
      // An installation seeded before `deployment.manage` existed.
      await tx.role.create({
        data: {
          tenantId,
          name: 'Owner',
          builtIn: true,
          permissions: ['directory.read', 'directory.write'],
        },
      });
      // And a role an administrator deliberately narrowed. This one must not
      // move: the migration repairs an omission, it does not impose a policy.
      await tx.role.create({
        data: {
          tenantId,
          name: 'Read only',
          builtIn: false,
          permissions: ['directory.read'],
        },
      });
    });

    await applyMigration(tenantId);

    const { builtIn, custom } = await withTenant(tenantId, async (tx) => ({
      builtIn: await tx.role.findFirstOrThrow({ where: { name: 'Owner' } }),
      custom: await tx.role.findFirstOrThrow({ where: { name: 'Read only' } }),
    }));

    // U3 itself: the permission the Updates page is gated on.
    expect(builtIn.permissions).toContain('deployment.manage');
    // Everything the catalogue has, and nothing lost.
    expect([...builtIn.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(builtIn.permissions).toContain('directory.write');

    expect(custom.permissions).toEqual(['directory.read']);
  });

  /**
   * Running it twice must not differ from running it once. `migrate deploy`
   * applies a migration once, but a repair that is not idempotent is one
   * nobody can safely re-run by hand when it matters.
   */
  it('is idempotent', async () => {
    await withTenant(tenantId, (tx) =>
      tx.role.create({
        data: { tenantId, name: 'Owner', builtIn: true, permissions: ['audit.read'] },
      }),
    );

    await applyMigration(tenantId);
    const once = await withTenant(tenantId, (tx) =>
      tx.role.findFirstOrThrow({ where: { name: 'Owner' } }),
    );
    await applyMigration(tenantId);
    const twice = await withTenant(tenantId, (tx) =>
      tx.role.findFirstOrThrow({ where: { name: 'Owner' } }),
    );

    expect(twice.permissions).toEqual(once.permissions);
  });
});
