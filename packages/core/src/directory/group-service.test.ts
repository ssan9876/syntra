import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from './user-service.js';
import {
  addMember,
  createGroup,
  listGroupsForUser,
  listMembers,
  removeMember,
} from './group-service.js';

let tenantId: string;
let groupId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  await withTenant(tenantId, async (tx) => {
    const group = await createGroup(tx, 'Nurses');
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    groupId = group.id;
    userId = user.id;
  });
});

describe('addMember', () => {
  it('adds a user to a group', async () => {
    await withTenant(tenantId, (tx) => addMember(tx, groupId, userId));
    const members = await withTenant(tenantId, (tx) => listMembers(tx, groupId));
    expect(members.map((m) => m.login)).toEqual(['jdoe']);
  });

  it('is idempotent when the user is already a member', async () => {
    await withTenant(tenantId, (tx) => addMember(tx, groupId, userId));
    await withTenant(tenantId, (tx) => addMember(tx, groupId, userId));
    const members = await withTenant(tenantId, (tx) => listMembers(tx, groupId));
    expect(members).toHaveLength(1);
  });
});

describe('removeMember', () => {
  it('removes the membership but leaves the user intact', async () => {
    await withTenant(tenantId, (tx) => addMember(tx, groupId, userId));
    await withTenant(tenantId, (tx) => removeMember(tx, groupId, userId));

    const members = await withTenant(tenantId, (tx) => listMembers(tx, groupId));
    expect(members).toEqual([]);

    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { id: userId } }),
    );
    expect(user).not.toBeNull();
  });

  it('is silent when the membership does not exist', async () => {
    await expect(
      withTenant(tenantId, (tx) => removeMember(tx, groupId, userId)),
    ).resolves.toBeUndefined();
  });
});

describe('listGroupsForUser', () => {
  it('returns only the groups the user belongs to', async () => {
    await withTenant(tenantId, async (tx) => {
      const other = await createGroup(tx, 'Trainers');
      await addMember(tx, groupId, userId);
      // A second group the user is deliberately not a member of.
      expect(other.name).toBe('Trainers');
    });

    const groups = await withTenant(tenantId, (tx) =>
      listGroupsForUser(tx, userId),
    );
    expect(groups.map((g) => g.name)).toEqual(['Nurses']);
  });
});

describe('createGroup', () => {
  it('rejects a duplicate group name within the tenant', async () => {
    await expect(
      withTenant(tenantId, (tx) => createGroup(tx, 'Nurses')),
    ).rejects.toThrow();
  });
});
