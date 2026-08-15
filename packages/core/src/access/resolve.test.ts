import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { addMember, createGroup } from '../directory/group-service.js';
import { createOrgUnit } from '../directory/org-unit-service.js';
import { createUser } from '../directory/user-service.js';
import { createApplication, updateApplication } from './application-service.js';
import { assignApplication, listAssignments, unassignApplication } from './assignment-service.js';
import {
  isApplicationAssigned,
  resolveApplicationsForUser,
  resolveApplicationIdsForUser,
} from './resolve.js';

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

const app = (slug: string) =>
  withTenant(tenantId, (tx) =>
    createApplication(tx, {
      name: slug.toUpperCase(),
      slug,
      launchUrl: `https://${slug}.acme.test/`,
    }),
  );

const names = async () => {
  const rows = await withTenant(tenantId, (tx) => resolveApplicationsForUser(tx, userId));
  return rows.map((r) => r.slug).sort();
};

describe('resolveApplicationsForUser', () => {
  it('returns nothing when nothing is assigned', async () => {
    await app('crm');
    expect(await names()).toEqual([]);
  });

  it('returns an application assigned directly to the user', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, (tx) =>
      assignApplication(tx, crm.id, { type: 'user', id: userId }),
    );
    expect(await names()).toEqual(['crm']);
  });

  it('returns an application assigned to a group the user is in', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
    });
    expect(await names()).toEqual(['crm']);
  });

  it('does not return an application assigned to a group the user left', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
    });
    expect(await names()).toEqual([]);
  });

  it('returns an application assigned to the user org unit', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const ou = await createOrgUnit(tx, 'Care');
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: ou.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: ou.id });
    });
    expect(await names()).toEqual(['crm']);
  });

  it('inherits an assignment made on a parent org unit', async () => {
    // An assignment on Head Office that did not reach Care would make the org
    // tree decorative: every grant would have to be repeated at every leaf.
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: care.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: head.id });
    });
    expect(await names()).toEqual(['crm']);
  });

  it('does not inherit downwards from a child org unit', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: head.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: care.id });
    });
    expect(await names()).toEqual([]);
  });

  it('is a union: the same application through two paths appears once', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
    });
    expect(await names()).toEqual(['crm']);
  });

  it('is a union: different applications through different paths all appear', async () => {
    const crm = await app('crm');
    const wiki = await app('wiki');
    const rota = await app('rota');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      const ou = await createOrgUnit(tx, 'Care');
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: ou.id } });

      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await assignApplication(tx, wiki.id, { type: 'group', id: g.id });
      await assignApplication(tx, rota.id, { type: 'orgUnit', id: ou.id });
    });
    expect(await names()).toEqual(['crm', 'rota', 'wiki']);
  });

  it('leaves out an application that has been retired', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await updateApplication(tx, crm.id, { status: 'inactive' });
    });
    expect(await names()).toEqual([]);
  });

  it('leaves a hidden application out of the portal but keeps it resolvable', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await updateApplication(tx, crm.id, { visibility: 'hidden' });
    });
    expect(await names()).toEqual([]);
    expect(
      await withTenant(tenantId, (tx) => isApplicationAssigned(tx, userId, crm.id)),
    ).toBe(true);
  });

  it('returns tiles ordered by name so the portal is stable between loads', async () => {
    const zebra = await app('zebra');
    const alpha = await app('alpha');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, zebra.id, { type: 'user', id: userId });
      await assignApplication(tx, alpha.id, { type: 'user', id: userId });
    });
    const rows = await withTenant(tenantId, (tx) => resolveApplicationsForUser(tx, userId));
    expect(rows.map((r) => r.slug)).toEqual(['alpha', 'zebra']);
  });

  it('drops the assignment when the application is removed', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, (tx) =>
      assignApplication(tx, crm.id, { type: 'user', id: userId }),
    );
    await withTenant(tenantId, (tx) => tx.application.delete({ where: { id: crm.id } }));
    expect(await withTenant(tenantId, (tx) => tx.appAssignment.count())).toBe(0);
  });
});

describe('assignments', () => {
  it('is idempotent', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
    });
    expect(await withTenant(tenantId, (tx) => listAssignments(tx, crm.id))).toHaveLength(1);
  });

  it('removes only the named assignment', async () => {
    const crm = await app('crm');
    const rows = await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
      return listAssignments(tx, crm.id);
    });
    await withTenant(tenantId, (tx) => unassignApplication(tx, rows[0]!.id));
    expect(await withTenant(tenantId, (tx) => listAssignments(tx, crm.id))).toHaveLength(1);
  });
});

describe('resolveApplicationIdsForUser', () => {
  it('includes hidden applications, which the portal filter then removes', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await updateApplication(tx, crm.id, { visibility: 'hidden' });
    });
    const ids = await withTenant(tenantId, (tx) => resolveApplicationIdsForUser(tx, userId));
    expect([...ids]).toEqual([crm.id]);
  });
});
