import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import {
  createPerson,
  linkUserToPerson,
  personForUser,
  usersForPerson,
} from './person-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('person and account linking', () => {
  it('links one person to several accounts', async () => {
    const { personId, adminId } = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, {
        givenName: 'Jo',
        familyName: 'Doe',
      });
      const everyday = await createUser(tx, {
        login: 'jdoe',
        email: 'j@acme.test',
        displayName: 'J Doe',
      });
      const admin = await createUser(tx, {
        login: 'jdoe-adm',
        email: 'j.adm@acme.test',
        displayName: 'J Doe (admin)',
      });
      await linkUserToPerson(tx, everyday.id, person.id);
      await linkUserToPerson(tx, admin.id, person.id);
      return { personId: person.id, adminId: admin.id };
    });

    const accounts = await withTenant(tenantId, (tx) =>
      usersForPerson(tx, personId),
    );
    expect(accounts.map((u) => u.login).sort()).toEqual(['jdoe', 'jdoe-adm']);

    const back = await withTenant(tenantId, (tx) => personForUser(tx, adminId));
    expect(back?.givenName).toBe('Jo');
  });

  it('returns null for a service account with no person behind it', async () => {
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'svc-backup',
        email: 'svc@acme.test',
        displayName: 'Backup service',
      }),
    );
    const person = await withTenant(tenantId, (tx) =>
      personForUser(tx, user.id),
    );
    expect(person).toBeNull();
  });

  it('rejects a duplicate external id within a tenant', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, {
        givenName: 'Jo',
        familyName: 'Doe',
        externalId: 'E1',
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        createPerson(tx, {
          givenName: 'Sam',
          familyName: 'Roe',
          externalId: 'E1',
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows the same external id in a different tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Jo', familyName: 'Doe', externalId: 'E1' }),
    );
    const second = await withTenant(other.id, (tx) =>
      createPerson(tx, { givenName: 'Sam', familyName: 'Roe', externalId: 'E1' }),
    );
    expect(second.externalId).toBe('E1');
  });
});
