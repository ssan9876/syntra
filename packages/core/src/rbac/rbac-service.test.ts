import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createOrgUnit } from '../directory/org-unit-service.js';
import { PERMISSIONS } from './permissions.js';
import {
  assignRole,
  createRole,
  hasPermission,
  isAdministrator,
  permissionsForUser,
  revokeRole,
} from './rbac-service.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const user = await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J' }),
  );
  userId = user.id;
});

describe('permissionsForUser', () => {
  it('is empty for a user with no roles', async () => {
    const perms = await withTenant(tenantId, (tx) =>
      permissionsForUser(tx, userId),
    );
    expect(perms.size).toBe(0);
  });

  it('unions the permissions of every assigned role', async () => {
    await withTenant(tenantId, async (tx) => {
      const reader = await createRole(tx, 'Reader', [
        PERMISSIONS.DIRECTORY_READ,
      ]);
      const writer = await createRole(tx, 'Writer', [
        PERMISSIONS.DIRECTORY_WRITE,
      ]);
      await assignRole(tx, userId, reader.id);
      await assignRole(tx, userId, writer.id);
    });

    const perms = await withTenant(tenantId, (tx) =>
      permissionsForUser(tx, userId),
    );
    expect([...perms].sort()).toEqual(
      [PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE].sort(),
    );
  });

  it('deduplicates a permission granted by two roles', async () => {
    await withTenant(tenantId, async (tx) => {
      const a = await createRole(tx, 'A', [PERMISSIONS.DIRECTORY_READ]);
      const b = await createRole(tx, 'B', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, a.id);
      await assignRole(tx, userId, b.id);
    });

    const perms = await withTenant(tenantId, (tx) =>
      permissionsForUser(tx, userId),
    );
    expect([...perms]).toEqual([PERMISSIONS.DIRECTORY_READ]);
  });
});

describe('hasPermission', () => {
  it('grants an unscoped assignment everywhere', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });
    const ou = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'Finance'));

    const allowed = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_READ, ou.id),
    );
    expect(allowed).toBe(true);
  });

  it('confines a scoped assignment to its org unit', async () => {
    const finance = await withTenant(tenantId, (tx) =>
      createOrgUnit(tx, 'Finance'),
    );
    const ops = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'Ops'));
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id, finance.id);
    });

    const inScope = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_READ, finance.id),
    );
    const outOfScope = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_READ, ops.id),
    );
    expect(inScope).toBe(true);
    expect(outOfScope).toBe(false);
  });

  it('denies a scoped assignment when no scope is supplied', async () => {
    const finance = await withTenant(tenantId, (tx) =>
      createOrgUnit(tx, 'Finance'),
    );
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id, finance.id);
    });

    // A tenant-wide question asked by someone holding only a scoped grant
    // must be refused, not silently widened.
    const allowed = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_READ),
    );
    expect(allowed).toBe(false);
  });

  it('denies a permission the role does not carry', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });
    const allowed = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_WRITE),
    );
    expect(allowed).toBe(false);
  });

  it('does not see a role assignment from another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(other.id, async (tx) => {
      const stranger = await createUser(tx, {
        login: 'stranger',
        email: 's@other.test',
        displayName: 'S',
      });
      const role = await createRole(tx, 'Admin', [PERMISSIONS.TENANT_MANAGE]);
      await assignRole(tx, stranger.id, role.id);
    });

    const allowed = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.TENANT_MANAGE),
    );
    expect(allowed).toBe(false);
  });
});

describe('revokeRole', () => {
  it('removes the permission it granted', async () => {
    const roleId = await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
      return role.id;
    });

    await withTenant(tenantId, (tx) => revokeRole(tx, userId, roleId));
    const perms = await withTenant(tenantId, (tx) =>
      permissionsForUser(tx, userId),
    );
    expect(perms.size).toBe(0);
  });
});

describe('isAdministrator', () => {
  it('is false with no roles and true once any role is assigned', async () => {
    expect(
      await withTenant(tenantId, (tx) => isAdministrator(tx, userId)),
    ).toBe(false);

    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });

    expect(
      await withTenant(tenantId, (tx) => isAdministrator(tx, userId)),
    ).toBe(true);
  });
});

describe('assignRole', () => {
  it('is idempotent for the same role and scope', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
      await assignRole(tx, userId, role.id);
    });

    const count = await withTenant(tenantId, (tx) =>
      tx.roleAssignment.count({ where: { userId } }),
    );
    expect(count).toBe(1);
  });

  it('is refused by the database if application code inserts a duplicate', async () => {
    const roleId = await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
      return role.id;
    });

    // Bypasses assignRole entirely. The compound unique cannot cover this
    // case because scopeOrgUnitId is null; the partial index must.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.roleAssignment.create({
          data: { tenantId, roleId, userId, scopeOrgUnitId: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows the same role scoped to two different org units', async () => {
    const finance = await withTenant(tenantId, (tx) =>
      createOrgUnit(tx, 'Finance'),
    );
    const ops = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'Ops'));

    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id, finance.id);
      await assignRole(tx, userId, role.id, ops.id);
    });

    const count = await withTenant(tenantId, (tx) =>
      tx.roleAssignment.count({ where: { userId } }),
    );
    expect(count).toBe(2);
  });
});
