import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { OWNER_PERMISSIONS, PERMISSIONS } from '../rbac/permissions.js';
import { SYSTEM_ROLE_KEYS, assignRole, createRole } from '../rbac/rbac-service.js';
import { readSignInSecurity } from './sign-in-security.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
});

const user = (login: string) =>
  withTenant(tenantId, async (tx) =>
    (await tx.user.create({ data: { tenantId, login, email: `${login}@acme.test`, displayName: login } })).id);

describe('readSignInSecurity', () => {
  it('reports nothing to list on a tenant with no role holders', async () => {
    await user('plain');
    expect(await withTenant(tenantId, (tx) => readSignInSecurity(tx))).toEqual({
      adminsWithoutSecondFactor: [],
      adminMfaRequired: false,
      lockoutEnabled: false,
      breakGlassDesignated: false,
    });
  });

  it('counts a scoped role holder as an administrator, but not as an Owner', async () => {
    const scoped = await user('scoped');
    const owner = await user('owner');
    await withTenant(tenantId, async (tx) => {
      const unit = await tx.orgUnit.create({ data: { tenantId, name: 'Sales' } });
      const ownerRole = await createRole(tx, 'Owner', [...OWNER_PERMISSIONS], { systemKey: SYSTEM_ROLE_KEYS.OWNER });
      const helpdesk = await createRole(tx, 'Help desk', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, scoped, ownerRole.id, unit.id);
      await assignRole(tx, scoped, helpdesk.id);
      await assignRole(tx, owner, ownerRole.id);
    });

    const result = await withTenant(tenantId, (tx) => readSignInSecurity(tx));
    expect(result.adminsWithoutSecondFactor).toEqual([
      { userId: owner, login: 'owner', displayName: 'owner', owner: true },
      { userId: scoped, login: 'scoped', displayName: 'scoped', owner: false },
    ]);
  });

  it('counts the security-key requirement for the console as requiring a second factor', async () => {
    await withTenant(tenantId, (tx) =>
      tx.tenant.update({ where: { id: tenantId }, data: { adminWebauthnRequired: true } }));
    expect((await withTenant(tenantId, (tx) => readSignInSecurity(tx))).adminMfaRequired).toBe(true);
  });
});
