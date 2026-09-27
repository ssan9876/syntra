import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createPerson, linkUserToPerson } from './person-service.js';
import { EmailInUseError, followPersonEmail } from './person-email.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('createPerson', () => {
  it('refuses a business email another person has, in any case', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Jane', familyName: 'Doe', businessEmail: 'jane@acme.test' }),
    );

    const refused = withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Janet', familyName: 'Doe', businessEmail: 'JANE@acme.test' }),
    );

    await expect(refused).rejects.toBeInstanceOf(EmailInUseError);
    await expect(refused).rejects.toThrow('Jane Doe already has JANE@acme.test.');
  });

  it('refuses an address held by an inactive person', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.create({
        data: { tenantId, givenName: 'Jane', familyName: 'Doe', businessEmail: 'jane@acme.test', status: 'inactive' },
      }),
    );

    await expect(
      withTenant(tenantId, (tx) =>
        createPerson(tx, { givenName: 'Janet', familyName: 'Roe', businessEmail: 'jane@acme.test' }),
      ),
    ).rejects.toBeInstanceOf(EmailInUseError);
  });

  it('treats an underscore as a character, not a wildcard', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Jane', familyName: 'Doe', businessEmail: 'jane_doe@acme.test' }),
    );

    const created = await withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Jane', familyName: 'Xoe', businessEmail: 'janeXdoe@acme.test' }),
    );
    expect(created.businessEmail).toBe('janeXdoe@acme.test');
  });

  it('lets any number of people have no business email', async () => {
    await withTenant(tenantId, async (tx) => {
      await createPerson(tx, { givenName: 'A', familyName: 'One' });
      await createPerson(tx, { givenName: 'B', familyName: 'Two' });
    });
    expect(await withTenant(tenantId, (tx) => tx.person.count())).toBe(2);
  });
});

describe('linkUserToPerson', () => {
  it("gives the login the person's business email", async () => {
    const user = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'Jane', familyName: 'Doe', businessEmail: 'jane.doe@acme.test' });
      const created = await createUser(tx, { login: 'jdoe', email: 'jd@acme.test', displayName: 'Jane' });
      await linkUserToPerson(tx, created.id, person.id);
      return tx.user.findUniqueOrThrow({ where: { id: created.id } });
    });

    expect(user.email).toBe('jane.doe@acme.test');
  });

  it('leaves the login its own email when the person has none', async () => {
    const user = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'Jane', familyName: 'Doe' });
      const created = await createUser(tx, { login: 'jdoe', email: 'jd@acme.test', displayName: 'Jane' });
      await linkUserToPerson(tx, created.id, person.id);
      return tx.user.findUniqueOrThrow({ where: { id: created.id } });
    });

    expect(user.email).toBe('jd@acme.test');
  });

  it('refuses when another login of nobody already has the address', async () => {
    const refused = withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'Jane', familyName: 'Doe', businessEmail: 'jane.doe@acme.test' });
      await createUser(tx, { login: 'shared', email: 'Jane.Doe@acme.test', displayName: 'Shared' });
      const created = await createUser(tx, { login: 'jdoe', email: 'jd@acme.test', displayName: 'Jane' });
      await linkUserToPerson(tx, created.id, person.id);
    });

    await expect(refused).rejects.toThrow('Account shared already has jane.doe@acme.test.');
  });

  it("lets a person's second login share the address", async () => {
    const logins = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'Jane', familyName: 'Doe', businessEmail: 'jane.doe@acme.test' });
      const everyday = await createUser(tx, { login: 'jdoe', email: 'jd@acme.test', displayName: 'Jane' });
      await linkUserToPerson(tx, everyday.id, person.id);
      const admin = await createUser(tx, {
        login: 'jdoe-admin',
        email: 'jane.doe@acme.test',
        displayName: 'Jane (admin)',
        personId: person.id,
      });
      await linkUserToPerson(tx, admin.id, person.id);
      return tx.user.findMany({ where: { personId: person.id }, orderBy: { login: 'asc' } });
    });

    expect(logins.map((u) => u.email)).toEqual(['jane.doe@acme.test', 'jane.doe@acme.test']);
  });
});

describe('followPersonEmail', () => {
  it("sets every linked login to the person's business email", async () => {
    const emails = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'Jane', familyName: 'Doe', businessEmail: 'jane@acme.test' });
      const user = await createUser(tx, { login: 'jdoe', email: 'jd@acme.test', displayName: 'Jane' });
      await linkUserToPerson(tx, user.id, person.id);
      await tx.person.update({ where: { id: person.id }, data: { businessEmail: 'jane.doe@acme.test' } });
      expect(await followPersonEmail(tx, person.id)).toBe(1);
      return (await tx.user.findMany()).map((u) => u.email);
    });

    expect(emails).toEqual(['jane.doe@acme.test']);
  });

  it('leaves a login with no person alone', async () => {
    const user = await withTenant(tenantId, async (tx) => {
      await createPerson(tx, { givenName: 'Jane', familyName: 'Doe', businessEmail: 'jane@acme.test' });
      const service = await createUser(tx, { login: 'svc', email: 'svc@acme.test', displayName: 'Service', kind: 'service' });
      return tx.user.findUniqueOrThrow({ where: { id: service.id } });
    });

    expect(user.email).toBe('svc@acme.test');
  });
});
