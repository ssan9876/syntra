import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, listUsers } from './user-service.js';
import { createGroup, listGroups } from './group-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('listUsers', () => {
  it('pages, and reports the total it paged through', async () => {
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 7; i += 1) {
        await createUser(tx, {
          login: `user${i}`,
          email: `user${i}@acme.test`,
          displayName: `User ${i}`,
        });
      }
    });
    const page = await withTenant(tenantId, (tx) =>
      listUsers(tx, { page: 2, pageSize: 3 }),
    );
    expect(page.rows.map((r) => r.login)).toEqual(['user3', 'user4', 'user5']);
    expect(page.total).toBe(7);
  });

  it('searches login, display name and email, case-insensitively', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'barcher',
        email: 'brady.archer@acme.test',
        displayName: 'Brady Archer',
      }),
    );
    for (const term of ['BARCH', 'brady arch', 'archer@acme']) {
      const page = await withTenant(tenantId, (tx) => listUsers(tx, { search: term }));
      expect(page.total, `searching ${term}`).toBe(1);
    }
  });

  it('still honours the status filter it already had', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'a', email: 'a@acme.test', displayName: 'A' }),
    );
    const page = await withTenant(tenantId, (tx) => listUsers(tx, { status: 'inactive' }));
    expect(page.total).toBe(0);
  });
});

describe('listGroups', () => {
  it('pages and searches name and description', async () => {
    await withTenant(tenantId, async (tx) => {
      await createGroup(tx, 'Payroll', 'Finance systems');
      await createGroup(tx, 'Engineering', 'Builders');
    });
    const all = await withTenant(tenantId, (tx) => listGroups(tx, {}));
    expect(all.total).toBe(2);

    const byName = await withTenant(tenantId, (tx) => listGroups(tx, { search: 'payr' }));
    expect(byName.rows.map((r) => r.name)).toEqual(['Payroll']);

    const byDescription = await withTenant(tenantId, (tx) =>
      listGroups(tx, { search: 'finance' }),
    );
    expect(byDescription.rows.map((r) => r.name)).toEqual(['Payroll']);
  });
});
