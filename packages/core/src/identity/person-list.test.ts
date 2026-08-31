import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createPerson, deactivatePerson, listPersons } from './person-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

async function seed(count: number) {
  return withTenant(tenantId, async (tx) => {
    const made = [];
    for (let i = 0; i < count; i += 1) {
      made.push(
        await createPerson(tx, {
          givenName: `Given${i}`,
          familyName: `Family${String(i).padStart(3, '0')}`,
          businessEmail: `p${i}@acme.test`,
          externalId: `E${i}`,
        }),
      );
    }
    return made;
  });
}

describe('listPersons', () => {
  it('returns one page and the total that page is drawn from', async () => {
    await seed(12);
    const page = await withTenant(tenantId, (tx) =>
      listPersons(tx, { page: 2, pageSize: 5 }),
    );
    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(12);
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(5);
    expect(page.rows[0]?.familyName).toBe('Family005');
  });

  it('matches a substring of the family name, case-insensitively', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Brady', familyName: 'Marchetti' }),
    );
    const page = await withTenant(tenantId, (tx) => listPersons(tx, { search: 'ARCH' }));
    expect(page.rows.map((r) => r.familyName)).toEqual(['Marchetti']);
    expect(page.total).toBe(1);
  });

  it('matches the external id and the business email', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, {
        givenName: 'Jo',
        familyName: 'Doe',
        externalId: 'EMP-4471',
        businessEmail: 'jo.doe@acme.test',
      }),
    );
    const byId = await withTenant(tenantId, (tx) => listPersons(tx, { search: '4471' }));
    const byMail = await withTenant(tenantId, (tx) => listPersons(tx, { search: 'jo.doe' }));
    expect(byId.total).toBe(1);
    expect(byMail.total).toBe(1);
  });

  // A home address is not an admin search key. Matching it would turn finding a
  // colleague into searching staff by private contact details.
  it('does NOT match a personal email address', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, {
        givenName: 'Jo',
        familyName: 'Doe',
        personalEmail: 'jo@hotmail.test',
      }),
    );
    const page = await withTenant(tenantId, (tx) => listPersons(tx, { search: 'hotmail' }));
    expect(page.total).toBe(0);
  });

  it('treats a whitespace-only search as no search at all', async () => {
    await seed(3);
    const page = await withTenant(tenantId, (tx) => listPersons(tx, { search: '   ' }));
    expect(page.total).toBe(3);
  });

  it('counts what matches the filter, not what is in the table', async () => {
    const made = await seed(4);
    await withTenant(tenantId, (tx) => deactivatePerson(tx, made[0]!.id));
    const page = await withTenant(tenantId, (tx) => listPersons(tx, { status: 'active' }));
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(3);
  });

  it('answers a page past the end with no rows and a truthful total', async () => {
    await seed(3);
    const page = await withTenant(tenantId, (tx) =>
      listPersons(tx, { page: 9, pageSize: 10 }),
    );
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(3);
  });

  it('defaults to the first page of fifty', async () => {
    await seed(2);
    const page = await withTenant(tenantId, (tx) => listPersons(tx, {}));
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(50);
  });
});
