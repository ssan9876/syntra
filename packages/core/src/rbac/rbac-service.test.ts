import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createOrgUnit } from '../directory/org-unit-service.js';
import { ALL_PERMISSIONS, PERMISSIONS } from './permissions.js';
import {
  assignRole,
  countHoldersOf,
  createRole,
  deleteRole,
  hasPermission,
  isAdministrator,
  listRoles,
  permissionsForUser,
  readRole,
  revokeRole,
  updateRole,
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

describe('editing a role', () => {
  /**
   * The whole reason this exists. `Role.permissions` is a stored snapshot
   * written once by the seed, and the catalogue grew in six later commits with
   * no migration behind them -- so an upgraded deployment's Owner got 403 on
   * every new module and the only remedy was hand-written SQL.
   */
  it('replaces the permission set', async () => {
    const roleId = await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Auditor', [PERMISSIONS.AUDIT_READ]);
      await updateRole(tx, role.id, {
        permissions: [PERMISSIONS.AUDIT_READ, PERMISSIONS.GOVERN_READ],
      });
      return role.id;
    });

    const after = await withTenant(tenantId, (tx) => readRole(tx, roleId));
    expect([...after.permissions].sort()).toEqual(
      [PERMISSIONS.AUDIT_READ, PERMISSIONS.GOVERN_READ].sort(),
    );
  });

  /**
   * The catalogue is closed and it is closed HERE, in the domain, not in a
   * zod enum at the edge. A second declaration of the same list is a second
   * thing to keep in step, and this one already exists and is already the
   * authority `hasPermission` compares against.
   */
  it('refuses a permission that is not in the catalogue', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const role = await createRole(tx, 'Odd', [PERMISSIONS.AUDIT_READ]);
        await updateRole(tx, role.id, { permissions: ['directory.reed'] });
      }),
    ).rejects.toThrow(/directory\.reed/);
  });

  it('renames without touching the permissions', async () => {
    const roleId = await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Auditor', [PERMISSIONS.AUDIT_READ]);
      await updateRole(tx, role.id, { name: 'Internal audit' });
      return role.id;
    });
    const after = await withTenant(tenantId, (tx) => readRole(tx, roleId));
    expect(after.name).toBe('Internal audit');
    expect(after.permissions).toEqual([PERMISSIONS.AUDIT_READ]);
  });
});

describe('deleting a role', () => {
  it('deletes one nobody holds', async () => {
    const roleId = await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Temporary', [PERMISSIONS.AUDIT_READ]);
      await deleteRole(tx, role.id);
      return role.id;
    });
    const rows = await withTenant(tenantId, (tx) => listRoles(tx));
    expect(rows.map((r) => r.id)).not.toContain(roleId);
  });

  /**
   * A built-in role is the one the seed wrote and the one the migration
   * backfills. Deleting it is not an edit an administrator can undo, and the
   * assignment rows cascade with it.
   */
  it('refuses a built-in role', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const role = await createRole(tx, 'Owner', ALL_PERMISSIONS, { builtIn: true });
        await deleteRole(tx, role.id);
      }),
    ).rejects.toThrow(/built-in/);
  });

  it('refuses one that is still assigned, and names the count', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const user = await createUser(tx, {
          login: 'a', email: 'a@acme.test', displayName: 'A',
        });
        const role = await createRole(tx, 'Held', [PERMISSIONS.AUDIT_READ]);
        await assignRole(tx, user.id, role.id);
        await deleteRole(tx, role.id);
      }),
    ).rejects.toThrow(/1 /);
  });
});

describe('countHoldersOf', () => {
  /**
   * The denominator behind the lockout guard the API applies. Unscoped
   * assignments ONLY: `hasPermission` deliberately refuses a scoped grant
   * asked tenant-wide, so a department-scoped `rbac.manage` cannot administer
   * roles and must not count towards "somebody can still do this".
   */
  it('counts people holding it tenant-wide, once each', async () => {
    const count = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'b', email: 'b@acme.test', displayName: 'B',
      });
      const one = await createRole(tx, 'One', [PERMISSIONS.RBAC_MANAGE]);
      const two = await createRole(tx, 'Two', [PERMISSIONS.RBAC_MANAGE]);
      await assignRole(tx, user.id, one.id);
      await assignRole(tx, user.id, two.id);
      return countHoldersOf(tx, PERMISSIONS.RBAC_MANAGE);
    });
    expect(count).toBe(1);
  });

  it('does not count a scoped assignment', async () => {
    const count = await withTenant(tenantId, async (tx) => {
      const unit = await createOrgUnit(tx, 'Care');
      const user = await createUser(tx, {
        login: 'c', email: 'c@acme.test', displayName: 'C',
      });
      const role = await createRole(tx, 'Scoped', [PERMISSIONS.RBAC_MANAGE]);
      await assignRole(tx, user.id, role.id, unit.id);
      return countHoldersOf(tx, PERMISSIONS.RBAC_MANAGE);
    });
    expect(count).toBe(0);
  });
});
