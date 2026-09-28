import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATA_DELETION_ROLE } from '@syntra/core';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

const sql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20261111000000_data_deletion_role/migration.sql',
  ),
  'utf8',
);

/** The per-tenant DO block alone: the column, index and CHECK already exist in the test schema. */
const perTenantBlock = sql.match(/DO \$\$[\s\S]*?END \$\$;/)![0];

/** Run as `prisma migrate deploy` runs it: as syntra_app, no tenant bound. */
const applyUnbound = () => prisma.$executeRawUnsafe(perTenantBlock);

describe('the Data deletion role migration', () => {
  let tenantIds: string[];

  beforeEach(async () => {
    await resetDatabase();
    const tenants = await Promise.all(
      ['Acme', 'Globex'].map((name, i) =>
        prisma.tenant.create({ data: { name, slug: `${name.toLowerCase()}-${i}` } }),
      ),
    );
    tenantIds = tenants.map((t) => t.id);
    for (const id of tenantIds) {
      await withTenant(id, (tx) =>
        tx.role.create({
          data: { tenantId: id, name: 'Owner', builtIn: true, permissions: ['rbac.manage'] },
        }),
      );
    }
  });

  it('keys each Owner and adds one Data deletion role per tenant, holding only person.purge', async () => {
    await applyUnbound();

    for (const id of tenantIds) {
      const roles = await withTenant(id, (tx) => tx.role.findMany({ orderBy: { name: 'asc' } }));
      expect(roles.map((r) => [r.name, r.systemKey, r.builtIn, r.permissions])).toEqual([
        [DATA_DELETION_ROLE.name, 'data-deletion', true, ['person.purge']],
        ['Owner', 'owner', true, ['rbac.manage']],
      ]);
      expect(roles[0]!.description).toBe(DATA_DELETION_ROLE.description);
    }
  });

  it('is idempotent', async () => {
    await applyUnbound();
    await applyUnbound();
    for (const id of tenantIds) {
      expect(await withTenant(id, (tx) => tx.role.count())).toBe(2);
    }
  });

  it('skips a tenant that already has a hand-made role of that name', async () => {
    await withTenant(tenantIds[0]!, (tx) =>
      tx.role.create({ data: { tenantId: tenantIds[0]!, name: 'Data deletion', permissions: ['audit.read'] } }),
    );
    await applyUnbound();
    const custom = await withTenant(tenantIds[0]!, (tx) =>
      tx.role.findFirstOrThrow({ where: { name: 'Data deletion' } }),
    );
    expect(custom.systemKey).toBeNull();
    expect(custom.permissions).toEqual(['audit.read']);
  });

  /** The CHECK: person.purge on any other role, or anything else on this one, is refused by the database. */
  it('refuses person.purge outside the Data deletion role, and widening that role', async () => {
    await applyUnbound();
    const id = tenantIds[0]!;
    await expect(
      withTenant(id, (tx) => tx.role.create({ data: { tenantId: id, name: 'Sneaky', permissions: ['person.purge'] } })),
    ).rejects.toThrow();
    await expect(
      withTenant(id, (tx) =>
        tx.role.updateMany({ where: { systemKey: 'data-deletion' }, data: { permissions: ['person.purge', 'rbac.manage'] } }),
      ),
    ).rejects.toThrow();
  });
});
