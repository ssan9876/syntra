import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  createUser,
  deactivateUser,
  findUserByLogin,
  listUsers,
} from './user-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('createUser', () => {
  it('creates a user with an active status', async () => {
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'jdoe@acme.test',
        displayName: 'J Doe',
      }),
    );
    expect(user.status).toBe('active');
    expect(user.personId).toBeNull();
  });

  it('rejects a duplicate login within the same tenant', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'a@acme.test', displayName: 'A' }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        createUser(tx, { login: 'jdoe', email: 'b@acme.test', displayName: 'B' }),
      ),
    ).rejects.toThrow(/login already exists/i);
  });

  it('allows the same login in a different tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'a@acme.test', displayName: 'A' }),
    );
    const second = await withTenant(other.id, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'b@other.test', displayName: 'B' }),
    );
    expect(second.login).toBe('jdoe');
  });
});

describe('deactivateUser', () => {
  it('records the reason and never deletes the row', async () => {
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J' }),
    );
    const after = await withTenant(tenantId, (tx) =>
      deactivateUser(tx, user.id, 'left the company'),
    );
    expect(after.status).toBe('inactive');
    expect(after.statusReason).toBe('left the company');

    const all = await withTenant(tenantId, (tx) => listUsers(tx));
    expect(all).toHaveLength(1);
  });
});

describe('listUsers', () => {
  it('filters by status when asked', async () => {
    await withTenant(tenantId, async (tx) => {
      const a = await createUser(tx, {
        login: 'a',
        email: 'a@acme.test',
        displayName: 'A',
      });
      await createUser(tx, { login: 'b', email: 'b@acme.test', displayName: 'B' });
      await deactivateUser(tx, a.id, 'left');
    });

    const active = await withTenant(tenantId, (tx) =>
      listUsers(tx, { status: 'active' }),
    );
    expect(active.map((u) => u.login)).toEqual(['b']);
  });
});

describe('findUserByLogin', () => {
  it('returns null for an unknown login', async () => {
    const found = await withTenant(tenantId, (tx) =>
      findUserByLogin(tx, 'nobody'),
    );
    expect(found).toBeNull();
  });

  it('does not find a user belonging to another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(other.id, (tx) =>
      createUser(tx, {
        login: 'elsewhere',
        email: 'e@other.test',
        displayName: 'E',
      }),
    );

    const found = await withTenant(tenantId, (tx) =>
      findUserByLogin(tx, 'elsewhere'),
    );
    expect(found).toBeNull();
  });
});
