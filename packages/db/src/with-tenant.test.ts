import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

describe('withTenant', () => {
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    await resetDatabase();
    const a = await prisma.tenant.create({ data: { name: 'A', slug: 'a' } });
    const b = await prisma.tenant.create({ data: { name: 'B', slug: 'b' } });
    tenantA = a.id;
    tenantB = b.id;
    // Seeded through withTenant: the RLS WITH CHECK clause rejects an insert
    // made with no tenant bound, which is the behaviour these tests assert.
    await withTenant(tenantA, (tx) =>
      tx.orgUnit.create({ data: { tenantId: tenantA, name: 'A root' } }),
    );
    await withTenant(tenantB, (tx) =>
      tx.orgUnit.create({ data: { tenantId: tenantB, name: 'B root' } }),
    );
  });

  it('sees only its own tenant rows', async () => {
    const rows = await withTenant(tenantA, (tx) => tx.orgUnit.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('A root');
  });

  it('returns nothing for a deliberately unscoped query in the wrong tenant', async () => {
    // The query has no where clause at all. RLS is the only thing protecting it.
    const rows = await withTenant(tenantB, (tx) =>
      tx.orgUnit.findMany({ where: {} }),
    );
    expect(rows.map((r) => r.name)).toEqual(['B root']);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.orgUnit.create({ data: { tenantId: tenantB, name: 'smuggled' } }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a write made with no tenant bound at all', async () => {
    // The connecting role is a non-superuser without BYPASSRLS, so a query
    // issued outside withTenant has no app.current_tenant to satisfy the
    // policy. If this ever passes, the role has regained a bypass privilege.
    await expect(
      prisma.orgUnit.create({ data: { tenantId: tenantA, name: 'unbound' } }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('reads nothing when no tenant is bound', async () => {
    const rows = await prisma.orgUnit.findMany();
    expect(rows).toEqual([]);
  });

  it('rolls back when the callback throws', async () => {
    await expect(
      withTenant(tenantA, async (tx) => {
        await tx.orgUnit.create({ data: { tenantId: tenantA, name: 'temp' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = await withTenant(tenantA, (tx) => tx.orgUnit.findMany());
    expect(rows).toHaveLength(1);
  });
});
