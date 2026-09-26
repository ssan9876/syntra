import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  addMember,
  createGroup,
  deactivateGroup,
  reactivateGroup,
} from '../directory/group-service.js';
import { createOrgUnit, deactivateOrgUnit } from '../directory/org-unit-service.js';
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

describe('updateApplication', () => {
  it('CHANGES THE TYPE, so a bookmark can become a service provider', async () => {
    // `updateApplicationRequest` accepts `type` and the update dropped it, so
    // PUT answered 200 and changed nothing. The only way to register SAML
    // against an application somebody had already created was to delete it and
    // make it again — losing its assignments — and the API reported success
    // the whole time.
    const app = await withTenant(tenantId, (tx) =>
      createApplication(tx, {
        name: 'Snipe-IT',
        slug: 'snipe-it',
        launchUrl: 'https://snipeit.example.test/',
      }),
    );
    expect(app.type).toBe('bookmark');

    const updated = await withTenant(tenantId, (tx) =>
      updateApplication(tx, app.id, { type: 'saml' }),
    );
    expect(updated.type).toBe('saml');

    // And it is the STORED row that changed, not just what the call returned.
    const reread = await withTenant(tenantId, (tx) =>
      tx.application.findUniqueOrThrow({ where: { id: app.id } }),
    );
    expect(reread.type).toBe('saml');
  });

  it('leaves the type alone when it is not named', async () => {
    const app = await withTenant(tenantId, (tx) =>
      createApplication(tx, {
        name: 'Rota',
        slug: 'rota',
        type: 'saml',
        launchUrl: 'https://rota.example.test/',
      }),
    );
    const updated = await withTenant(tenantId, (tx) =>
      updateApplication(tx, app.id, { name: 'Rota planner' }),
    );
    expect(updated.type).toBe('saml');
  });
});

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

  it('grants NOTHING through a deactivated group', async () => {
    // The console offers Deactivate and never Delete precisely because a
    // deactivated group is supposed to keep its record and hand out nothing.
    // Resolution ignored `status` entirely, so the revocation succeeded on the
    // screen, wrote its reason to the row, and left every application the
    // group granted still resolving.
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
      await deactivateGroup(tx, g.id, 'ward closed');
    });
    expect(await names()).toEqual([]);
  });

  it('gives the access back when the group is reactivated', async () => {
    // Nothing is deleted, so nothing has to be rebuilt: the memberships and
    // the assignment are where they were. This is the other half of why the
    // product deactivates rather than deletes.
    const crm = await app('crm');
    const groupId = await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
      await deactivateGroup(tx, g.id, 'ward closed');
      return g.id;
    });
    expect(await names()).toEqual([]);
    await withTenant(tenantId, (tx) => reactivateGroup(tx, groupId));
    expect(await names()).toEqual(['crm']);
  });

  it('keeps access the user holds by another path', async () => {
    // Deactivating a group revokes what THAT group granted. A direct
    // assignment is a different grant and must survive, or one deactivation
    // becomes a way to cut access nobody meant to touch.
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await deactivateGroup(tx, g.id, 'ward closed');
    });
    expect(await names()).toEqual(['crm']);
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
    await withTenant(tenantId, (tx) => unassignApplication(tx, crm.id, rows[0]!.id));
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

/**
 * The org-unit arm starts from the login's EFFECTIVE unit: its own, else its
 * linked person's. On a real install people are placed in units (that drives
 * where the directory writes their account) and logins are not, and reading
 * only `User.orgUnitId` made an application assigned to a unit reach nobody.
 */
describe('org-unit assignments through the linked person', () => {
  const personIn = (orgUnitId: string | null, status = 'active') =>
    withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Jo', familyName: 'Doe', orgUnitId, status },
      });
      await tx.user.update({ where: { id: userId }, data: { personId: person.id } });
      return person;
    });

  it("reaches a login with no unit of its own through its person's unit", async () => {
    const crm = await app('crm');
    const it_ = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'IT'));
    await personIn(it_.id);
    await withTenant(tenantId, (tx) =>
      assignApplication(tx, crm.id, { type: 'orgUnit', id: it_.id }),
    );
    expect(await names()).toEqual(['crm']);
    expect(await withTenant(tenantId, (tx) => isApplicationAssigned(tx, userId, crm.id))).toBe(
      true,
    );
  });

  it("reaches it through the units above the person's unit too", async () => {
    const crm = await app('crm');
    const { head, care } = await withTenant(tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      return { head, care };
    });
    await personIn(care.id);
    await withTenant(tenantId, (tx) =>
      assignApplication(tx, crm.id, { type: 'orgUnit', id: head.id }),
    );
    expect(await names()).toEqual(['crm']);
  });

  it("lets the login's own unit override its person's", async () => {
    // A login's unit is set on the account deliberately — a contractor's login
    // kept in Contractors while their person sits in the team they work for.
    const crm = await app('crm');
    const wiki = await app('wiki');
    const { it_, contractors } = await withTenant(tenantId, async (tx) => ({
      it_: await createOrgUnit(tx, 'IT'),
      contractors: await createOrgUnit(tx, 'Contractors'),
    }));
    await personIn(it_.id);
    await withTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: contractors.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: it_.id });
      await assignApplication(tx, wiki.id, { type: 'orgUnit', id: contractors.id });
    });
    expect(await names()).toEqual(['wiki']);
  });

  it('inherits nothing when the login has no person', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const it_ = await createOrgUnit(tx, 'IT');
      // A person in IT who is NOT linked to this login.
      await tx.person.create({
        data: { tenantId, givenName: 'Other', familyName: 'Person', orgUnitId: it_.id },
      });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: it_.id });
    });
    expect(await names()).toEqual([]);
  });

  it('inherits nothing from a deactivated person', async () => {
    // Mirrors the rule for deactivated groups and units: the person path is a
    // way of reaching access, and a deactivated person reaches nothing by it.
    const crm = await app('crm');
    const it_ = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'IT'));
    await personIn(it_.id, 'inactive');
    await withTenant(tenantId, (tx) =>
      assignApplication(tx, crm.id, { type: 'orgUnit', id: it_.id }),
    );
    expect(await names()).toEqual([]);
  });

  it("grants nothing through the person's unit once that unit is deactivated", async () => {
    const crm = await app('crm');
    const it_ = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'IT'));
    await personIn(it_.id);
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: it_.id });
      await deactivateOrgUnit(tx, it_.id, 'team disbanded');
    });
    expect(await names()).toEqual([]);
  });
});
