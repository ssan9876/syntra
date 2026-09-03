import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createPerson, deactivatePerson, listPersons } from './person-service.js';
import { MAX_PAGE_SIZE } from '../list.js';

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

  // Two people with the same name are ordinary, and the sort has to put them
  // in the same order on every request or paging shows one twice and never
  // shows the other.
  it('shows two people with identical names once each across pages', async () => {
    const made = await withTenant(tenantId, async (tx) => [
      await createPerson(tx, { givenName: 'Sam', familyName: 'Lee' }),
      await createPerson(tx, { givenName: 'Sam', familyName: 'Lee' }),
    ]);
    const seen: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      for (const page of [1, 2]) {
        const result = await withTenant(tenantId, (tx) =>
          listPersons(tx, { page, pageSize: 1 }),
        );
        seen.push(...result.rows.map((r) => r.id));
      }
    }
    for (const person of made) {
      expect(seen.filter((id) => id === person.id)).toHaveLength(20);
    }
  });

  it('treats % and _ in a search as characters, not wildcards', async () => {
    await withTenant(tenantId, async (tx) => {
      await createPerson(tx, { givenName: 'A%B', familyName: 'Percent' });
      await createPerson(tx, { givenName: 'AXB', familyName: 'Plain' });
      await createPerson(tx, { givenName: 'A_B', familyName: 'Underscore' });
    });
    const percent = await withTenant(tenantId, (tx) => listPersons(tx, { search: '%' }));
    expect(percent.rows.map((r) => r.familyName)).toEqual(['Percent']);
    const underscore = await withTenant(tenantId, (tx) => listPersons(tx, { search: 'A_B' }));
    expect(underscore.rows.map((r) => r.familyName)).toEqual(['Underscore']);
  });

  it('clamps page 0 and a negative page to the first page', async () => {
    await seed(3);
    for (const page of [0, -4]) {
      const result = await withTenant(tenantId, (tx) =>
        listPersons(tx, { page, pageSize: 2 }),
      );
      expect(result.page).toBe(1);
      expect(result.rows.map((r) => r.familyName)).toEqual(['Family000', 'Family001']);
    }
  });

  it('caps an oversized page size at the ceiling and refuses an empty one', async () => {
    await seed(2);
    const big = await withTenant(tenantId, (tx) =>
      listPersons(tx, { pageSize: MAX_PAGE_SIZE * 10 }),
    );
    expect(big.pageSize).toBe(MAX_PAGE_SIZE);
    const none = await withTenant(tenantId, (tx) => listPersons(tx, { pageSize: 0 }));
    expect(none.pageSize).toBe(1);
    expect(none.rows).toHaveLength(1);
  });
});
