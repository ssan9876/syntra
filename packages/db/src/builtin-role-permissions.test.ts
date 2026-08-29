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
const REPAIR_MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../prisma/migrations/20260926000000_builtin_role_permissions_repair/migration.sql',
);

const sql = readFileSync(MIGRATION, 'utf8');
const repairSql = readFileSync(REPAIR_MIGRATION, 'utf8');

/**
 * Runs SQL exactly the way `prisma migrate deploy` does: as the application
 * role (`syntra_app`, NOSUPERUSER NOBYPASSRLS -- migrations do not run as a
 * different, RLS-exempt role), with no `app.current_tenant` bound. This is
 * what production actually does when it applies a migration.
 */
const applyUnbound = (statement: string) => prisma.$executeRawUnsafe(statement);

/** The quoted strings inside the migration's ARRAY[...] literal. */
const backfilled = (migrationSql: string): string[] =>
  [...(migrationSql.match(/ARRAY\[([\s\S]*?)\]::text\[\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
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
    expect(backfilled(sql).filter((p) => !catalog.has(p))).toEqual([]);
  });

  /**
   * U3, named. `deployment.manage` was added to the catalogue after every
   * existing deployment had been seeded, so the Updates page was hidden and
   * every update route answered 403 -- on the one feature whose whole point is
   * repairing a deployment.
   */
  it('includes deployment.manage', () => {
    expect(backfilled(sql)).toContain('deployment.manage');
  });

  /** Whatever the catalogue held when this was written, all of it. */
  it('is the full catalogue as of the migration', () => {
    expect(backfilled(sql).length).toBeGreaterThanOrEqual(20);
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
 * What actually happened in production, and what fixes it.
 *
 * `20260903000000_builtin_role_permissions` joins "Role" against itself with
 * no tenant bound. "Role" carries FORCE ROW LEVEL SECURITY, and migrations
 * run as `syntra_app`, which is NOSUPERUSER NOBYPASSRLS -- the migration role
 * is subject to RLS exactly like the application is. With no
 * `app.current_tenant` set, the policy predicate
 * `"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`
 * compares every row's tenantId against NULL, which is never true, so the
 * UPDATE matched zero rows, committed, and reported success.
 *
 * An earlier version of this file ran the migration through `withTenant`
 * before checking anything, which binds a tenant the real migration never
 * did -- so RLS let the UPDATE reach real rows, the test passed, and it
 * proved nothing about what production actually got. The tests below run the
 * SQL the way `prisma migrate deploy` really runs it.
 */
describe('what the backfill actually did in production', () => {
  let tenantId: string;

  beforeEach(async () => {
    await resetDatabase();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = tenant.id;
  });

  it('changed zero rows: the original migration never bound a tenant', async () => {
    await withTenant(tenantId, (tx) =>
      tx.role.create({
        data: { tenantId, name: 'Owner', builtIn: true, permissions: ['directory.read'] },
      }),
    );

    const before = await withTenant(tenantId, (tx) =>
      tx.role.findFirstOrThrow({ where: { name: 'Owner' } }),
    );

    // The real migration path: no withTenant, no app.current_tenant, exactly
    // what `prisma migrate deploy` did.
    await applyUnbound(sql);

    const after = await withTenant(tenantId, (tx) =>
      tx.role.findFirstOrThrow({ where: { name: 'Owner' } }),
    );

    // Documents the bug: the frozen role is still frozen. deployment.manage
    // and everything else the migration named never arrived.
    expect(after.permissions).toEqual(before.permissions);
    expect(after.permissions).not.toContain('deployment.manage');
  });
});

/**
 * The repair migration doing its job, against a database.
 *
 * It loops over every tenant and binds `app.current_tenant` before touching
 * "Role", the pattern `20260905000000_deployment_manage_backfill` and
 * `20260909000000_password_ageing` already established. Run the same way
 * production runs it -- no tenant bound from the test, because the migration
 * binds its own.
 */
describe('the repair migration', () => {
  let tenantIds: string[];

  beforeEach(async () => {
    await resetDatabase();
    const tenants = await Promise.all(
      ['Acme', 'Globex', 'Initech'].map((name, i) =>
        prisma.tenant.create({ data: { name, slug: `${name.toLowerCase()}-${i}` } }),
      ),
    );
    tenantIds = tenants.map((t) => t.id);

    // Every tenant gets a built-in role frozen at an old catalogue, and a
    // custom role an administrator deliberately narrowed -- which must not
    // move.
    for (const id of tenantIds) {
      await withTenant(id, (tx) =>
        tx.role.create({
          data: { tenantId: id, name: 'Owner', builtIn: true, permissions: ['directory.read'] },
        }),
      );
      await withTenant(id, (tx) =>
        tx.role.create({
          data: { tenantId: id, name: 'Read only', builtIn: false, permissions: ['directory.read'] },
        }),
      );
    }
  });

  it('grants every listed permission to the built-in role in every seeded tenant', async () => {
    await applyUnbound(repairSql);

    for (const id of tenantIds) {
      const { builtIn, custom } = await withTenant(id, async (tx) => ({
        builtIn: await tx.role.findFirstOrThrow({ where: { name: 'Owner' } }),
        custom: await tx.role.findFirstOrThrow({ where: { name: 'Read only' } }),
      }));

      for (const permission of backfilled(repairSql)) {
        expect(builtIn.permissions).toContain(permission);
      }
      expect(builtIn.permissions).toContain('deployment.manage');
      // Nothing already held was dropped.
      expect(builtIn.permissions).toContain('directory.read');
      // The custom role stays exactly as an administrator left it.
      expect(custom.permissions).toEqual(['directory.read']);
    }
  });

  /**
   * Running it twice must not differ from running it once. `migrate deploy`
   * applies a migration once, but a repair that is not idempotent is one
   * nobody can safely re-run by hand when it matters.
   */
  it('is idempotent', async () => {
    await applyUnbound(repairSql);
    const once = await Promise.all(
      tenantIds.map((id) =>
        withTenant(id, (tx) => tx.role.findFirstOrThrow({ where: { name: 'Owner' } })),
      ),
    );

    await applyUnbound(repairSql);
    const twice = await Promise.all(
      tenantIds.map((id) =>
        withTenant(id, (tx) => tx.role.findFirstOrThrow({ where: { name: 'Owner' } })),
      ),
    );

    expect(twice.map((r) => r.permissions)).toEqual(once.map((r) => r.permissions));
  });
});
