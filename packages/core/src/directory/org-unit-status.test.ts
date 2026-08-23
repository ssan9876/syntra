import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createApplication } from '../access/application-service.js';
import { assignApplication } from '../access/assignment-service.js';
import { resolveApplicationsForUser } from '../access/resolve.js';
import { assignRole, createRole, hasPermission } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { createUser } from './user-service.js';
import {
  createOrgUnit,
  deactivateOrgUnit,
  reactivateOrgUnit,
} from './org-unit-service.js';

/**
 * Org units were the one part of the directory with no way to retire them.
 * A department that closes had to be left standing and granting, or deleted —
 * and deleting one takes the record of who was in it, drops every application
 * assignment made on it, and orphans any administrative role scoped to it.
 *
 * The rule these tests pin down is the same one groups follow: A DEACTIVATED
 * THING GRANTS NOTHING, and nothing is destroyed doing it.
 */
let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

const slugs = async () => {
  const rows = await withTenant(tenantId, (tx) => resolveApplicationsForUser(tx, userId));
  return rows.map((r) => r.slug).sort();
};

describe('an org unit that has been deactivated', () => {
  it('stops granting the applications assigned to it', async () => {
    await withTenant(tenantId, async (tx) => {
      const crm = await createApplication(tx, {
        name: 'CRM',
        slug: 'crm',
        launchUrl: 'https://crm.acme.test/',
      });
      const care = await createOrgUnit(tx, 'Care');
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: care.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: care.id });
      await deactivateOrgUnit(tx, care.id, 'ward closed');
    });
    expect(await slugs()).toEqual([]);
  });

  it('KEEPS the users where they are', async () => {
    // Deactivating is not emptying. The membership is the record of who was in
    // the department when it closed, and it is the thing that makes
    // reactivation put back exactly what was there.
    const care = await withTenant(tenantId, async (tx) => {
      const unit = await createOrgUnit(tx, 'Care');
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: unit.id } });
      await deactivateOrgUnit(tx, unit.id, 'ward closed');
      return unit;
    });
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.orgUnitId).toBe(care.id);
  });

  it('gives the access back on reactivation', async () => {
    const careId = await withTenant(tenantId, async (tx) => {
      const crm = await createApplication(tx, {
        name: 'CRM',
        slug: 'crm',
        launchUrl: 'https://crm.acme.test/',
      });
      const care = await createOrgUnit(tx, 'Care');
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: care.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: care.id });
      await deactivateOrgUnit(tx, care.id, 'ward closed');
      return care.id;
    });
    expect(await slugs()).toEqual([]);
    await withTenant(tenantId, (tx) => reactivateOrgUnit(tx, careId));
    expect(await slugs()).toEqual(['crm']);
  });

  it('does NOT cut off the units above it', async () => {
    // The user is in a closed department, but they are still under the
    // division that contains it, and an assignment made there was never
    // deactivated. Dropping out of the upward walk would revoke access nobody
    // touched — the failure mode this test exists to catch.
    await withTenant(tenantId, async (tx) => {
      const hq = await createApplication(tx, {
        name: 'Intranet',
        slug: 'intranet',
        launchUrl: 'https://intranet.acme.test/',
      });
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: care.id } });
      await assignApplication(tx, hq.id, { type: 'orgUnit', id: head.id });
      await deactivateOrgUnit(tx, care.id, 'ward closed');
    });
    expect(await slugs()).toEqual(['intranet']);
  });

  it('does not touch its children', async () => {
    // Closing a department does not close the ones beneath it. A cascade would
    // be a second, larger decision hidden inside this one — and it could not
    // be undone, because the children it swept up are indistinguishable from
    // the ones that were already inactive.
    await withTenant(tenantId, async (tx) => {
      const app = await createApplication(tx, {
        name: 'Rota',
        slug: 'rota',
        launchUrl: 'https://rota.acme.test/',
      });
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: care.id } });
      await assignApplication(tx, app.id, { type: 'orgUnit', id: care.id });
      await deactivateOrgUnit(tx, head.id, 'restructure');
    });
    expect(await slugs()).toEqual(['rota']);
  });
});

describe('an administrative role scoped to a deactivated unit', () => {
  it('grants nothing', async () => {
    // Authority over a department that has been closed is authority over
    // nothing. Leaving it standing would make deactivation a control that
    // retires a unit's grants and quietly keeps its administrators.
    const careId = await withTenant(tenantId, async (tx) => {
      const care = await createOrgUnit(tx, 'Care');
      const role = await createRole(tx, 'Ward admin', [PERMISSIONS.DIRECTORY_WRITE]);
      await assignRole(tx, userId, role.id, care.id);
      return care.id;
    });

    expect(
      await withTenant(tenantId, (tx) =>
        hasPermission(tx, userId, PERMISSIONS.DIRECTORY_WRITE, careId),
      ),
    ).toBe(true);

    await withTenant(tenantId, (tx) => deactivateOrgUnit(tx, careId, 'ward closed'));

    expect(
      await withTenant(tenantId, (tx) =>
        hasPermission(tx, userId, PERMISSIONS.DIRECTORY_WRITE, careId),
      ),
    ).toBe(false);
  });

  it('leaves TENANT-WIDE roles alone', async () => {
    // The filter above must not reach an unscoped assignment, which has no
    // unit to be deactivated. Getting this wrong locks every administrator in
    // the tenant out at once, and it would only show up the first time
    // somebody deactivated any unit at all.
    const careId = await withTenant(tenantId, async (tx) => {
      const care = await createOrgUnit(tx, 'Care');
      const role = await createRole(tx, 'Directory admin', [PERMISSIONS.DIRECTORY_WRITE]);
      await assignRole(tx, userId, role.id);
      await deactivateOrgUnit(tx, care.id, 'ward closed');
      return care.id;
    });

    await withTenant(tenantId, async (tx) => {
      // Tenant-wide, and inside the deactivated unit too: an unscoped
      // assignment applies everywhere, and "everywhere" does not shrink.
      expect(await hasPermission(tx, userId, PERMISSIONS.DIRECTORY_WRITE)).toBe(true);
      expect(
        await hasPermission(tx, userId, PERMISSIONS.DIRECTORY_WRITE, careId),
      ).toBe(true);
    });
  });
});
