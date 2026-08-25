import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  assignRole,
  createGroup,
  createOrgUnit,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

/**
 * Editing what is already in the directory.
 *
 * The four pages could create and deactivate and nothing else, so a group or a
 * unit named wrongly had to be deactivated and replaced — which loses its
 * memberships and its assignments, and leaves a permanent inactive row that
 * exists only because of a typo.
 *
 * Two rules carry the weight here and both are tested against the API rather
 * than only hidden in the console: a SOURCE-OWNED row is refused, because the
 * next sync run would overwrite the change and a control that silently reverts
 * is worse than one that is absent; and a unit cannot be moved inside itself,
 * because nothing in the database stops it and the result is a silently
 * broken tree.
 */
let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

const patch = (url: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PATCH',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  await withTenant(ctx.tenantId, async (tx) => {
    const admin = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, admin.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Everything', [...ALL_PERMISSIONS]);
    await assignRole(tx, admin.id, role.id);
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const first = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${first}` },
    payload: { password: PASSWORD },
  });
  cookie = `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
});

/**
 * A source, so a row can be marked as owned by one.
 *
 * Through `withTenant`, like every other write here. Every tenant-scoped table
 * is FORCE ROW LEVEL SECURITY against `app.current_tenant`, so the bare client
 * cannot insert into one at all — and a bare READ matches nothing and looks
 * like missing data rather than a missing transaction.
 */
async function makeSource() {
  return withTenant(ctx.tenantId, (tx) =>
    tx.directorySource.create({
      data: {
        tenantId: ctx.tenantId,
        name: 'AD',
        type: 'ldap',
        config: {},
        secretName: 'src-secret',
      },
    }),
  );
}

/** A bare person row, for the tests that do not need a contract. */
async function makePerson(data: {
  givenName: string;
  familyName: string;
  businessEmail?: string;
  externalId?: string;
}) {
  return withTenant(ctx.tenantId, (tx) =>
    tx.person.create({ data: { tenantId: ctx.tenantId, ...data } }),
  );
}

describe('renaming a group', () => {
  it('saves the new name and keeps its members', async () => {
    const { groupId, userId } = await withTenant(ctx.tenantId, async (tx) => {
      const group = await createGroup(tx, 'Ward Nurses');
      const user = await createUser(tx, {
        login: 'mokafor',
        email: 'm@acme.test',
        displayName: 'M Okafor',
      });
      await tx.groupMembership.create({
        data: { tenantId: ctx.tenantId, groupId: group.id, userId: user.id },
      });
      return { groupId: group.id, userId: user.id };
    });

    const res = await patch(`/api/admin/groups/${groupId}`, {
      name: 'Ward Nurses (Nights)',
      description: 'Night shift',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Ward Nurses (Nights)' });

    // The point of editing rather than replacing: the membership survives.
    const members = await withTenant(ctx.tenantId, (tx) =>
      tx.groupMembership.findMany({ where: { groupId } }),
    );
    expect(members.map((m) => m.userId)).toEqual([userId]);
  });

  it('clears a description when it is sent as null', async () => {
    // Omitting a field in a PATCH means "leave alone", so clearing needs a
    // value that says so. Without null there is no way to remove a
    // description at all.
    const groupId = await withTenant(ctx.tenantId, async (tx) => {
      const group = await createGroup(tx, 'Payroll', 'temporary note');
      return group.id;
    });
    await patch(`/api/admin/groups/${groupId}`, { description: null });
    const after = await withTenant(ctx.tenantId, (tx) =>
      tx.group.findUniqueOrThrow({ where: { id: groupId } }),
    );
    expect(after.description).toBeNull();
    expect(after.name).toBe('Payroll');
  });

  it('marks the NAME field when another group already has it', async () => {
    const ids = await withTenant(ctx.tenantId, async (tx) => {
      const a = await createGroup(tx, 'Payroll');
      const b = await createGroup(tx, 'Finance');
      return { a: a.id, b: b.id };
    });
    const res = await patch(`/api/admin/groups/${ids.b}`, { name: 'Payroll' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errors).toEqual([
      { path: 'name', message: 'group already exists: Payroll' },
    ]);
  });

  it('lets a group keep its own name', async () => {
    // The clash check must compare against OTHER groups. Comparing against all
    // of them makes saving a description impossible without also renaming.
    const groupId = await withTenant(ctx.tenantId, async (tx) => {
      const g = await createGroup(tx, 'Payroll');
      return g.id;
    });
    const res = await patch(`/api/admin/groups/${groupId}`, {
      name: 'Payroll',
      description: 'Runs the payroll',
    });
    expect(res.statusCode).toBe(200);
  });

  it('REFUSES a group owned by a directory source', async () => {
    const source = await makeSource();
    const groupId = await withTenant(ctx.tenantId, async (tx) => {
      const g = await createGroup(tx, 'AD Nurses');
      await tx.group.update({
        where: { id: g.id },
        data: { sourceId: source.id, sourceAnchor: 'cn=nurses' },
      });
      return g.id;
    });
    const res = await patch(`/api/admin/groups/${groupId}`, { name: 'Renamed' });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://syntra.dev/problems/source-owned');
  });

  it('refuses a body that changes nothing', async () => {
    const groupId = await withTenant(ctx.tenantId, async (tx) =>
      (await createGroup(tx, 'Payroll')).id,
    );
    expect((await patch(`/api/admin/groups/${groupId}`, {})).statusCode).toBe(400);
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    // A client sending `displayname` should be told. Silently dropping it
    // makes a save that did nothing look like a save that worked.
    const groupId = await withTenant(ctx.tenantId, async (tx) =>
      (await createGroup(tx, 'Payroll')).id,
    );
    const res = await patch(`/api/admin/groups/${groupId}`, {
      name: 'Payroll',
      status: 'active',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('moving an org unit', () => {
  it('renames it and moves it under another unit', async () => {
    const ids = await withTenant(ctx.tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care');
      return { head: head.id, care: care.id };
    });
    const res = await patch(`/api/admin/org-units/${ids.care}`, {
      name: 'Community Care',
      parentId: ids.head,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Community Care',
      parentId: ids.head,
    });
  });

  it('moves it back to the top level when parentId is null', async () => {
    const ids = await withTenant(ctx.tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      return { head: head.id, care: care.id };
    });
    const res = await patch(`/api/admin/org-units/${ids.care}`, { parentId: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().parentId).toBeNull();
  });

  it('REFUSES a unit as its own parent', async () => {
    const care = await withTenant(ctx.tenantId, async (tx) =>
      (await createOrgUnit(tx, 'Care')).id,
    );
    const res = await patch(`/api/admin/org-units/${care}`, { parentId: care });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toBe('parentId');
  });

  it('REFUSES a move that would put a unit inside its own descendant', async () => {
    // Nothing in the database stops this, and the result is not a crash: the
    // units in the loop drop out of the tree the console draws and the
    // assignments made on them stop reaching anybody, with no error anywhere.
    const ids = await withTenant(ctx.tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      const ward = await createOrgUnit(tx, 'Ward B', care.id);
      return { head: head.id, ward: ward.id };
    });
    const res = await patch(`/api/admin/org-units/${ids.head}`, {
      parentId: ids.ward,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].message).toMatch(/inside itself/);

    // And the tree is untouched.
    const head = await withTenant(ctx.tenantId, (tx) =>
      tx.orgUnit.findUniqueOrThrow({ where: { id: ids.head } }),
    );
    expect(head.parentId).toBeNull();
  });

  it('allows a sideways move that is not a cycle', async () => {
    // The cycle check walks upwards; a sibling is not on that path. Refusing
    // this would make the whole control useless for reorganizing.
    const ids = await withTenant(ctx.tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      const ops = await createOrgUnit(tx, 'Operations', head.id);
      return { care: care.id, ops: ops.id };
    });
    const res = await patch(`/api/admin/org-units/${ids.care}`, {
      parentId: ids.ops,
    });
    expect(res.statusCode).toBe(200);
  });

  it('404s an unknown parent instead of writing a dangling id', async () => {
    const care = await withTenant(ctx.tenantId, async (tx) =>
      (await createOrgUnit(tx, 'Care')).id,
    );
    const res = await patch(`/api/admin/org-units/${care}`, {
      parentId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('editing a user', () => {
  it('changes the display name and email but never the login', async () => {
    const userId = await withTenant(ctx.tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'mokafor',
        email: 'm@acme.test',
        displayName: 'M Okafor',
      });
      return u.id;
    });

    const res = await patch(`/api/admin/users/${userId}/details`, {
      displayName: 'Maya Okafor',
      email: 'maya.okafor@acme.test',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      login: 'mokafor',
      displayName: 'Maya Okafor',
      email: 'maya.okafor@acme.test',
    });

    // `login` is what people sign in with and what the audit trail is read by.
    // Changing it is an account migration, not an edit — so the field is not
    // accepted at all rather than accepted and ignored.
    const refused = await patch(`/api/admin/users/${userId}/details`, {
      login: 'mokafor2',
    });
    expect(refused.statusCode).toBe(400);
  });

  it('moves a user into an org unit and back out again', async () => {
    const ids = await withTenant(ctx.tenantId, async (tx) => {
      const care = await createOrgUnit(tx, 'Care');
      const u = await createUser(tx, {
        login: 'jdoe',
        email: 'j@acme.test',
        displayName: 'J Doe',
      });
      return { care: care.id, user: u.id };
    });

    await patch(`/api/admin/users/${ids.user}/details`, { orgUnitId: ids.care });
    expect(
      (
        await withTenant(ctx.tenantId, (tx) =>
          tx.user.findUniqueOrThrow({ where: { id: ids.user } }),
        )
      ).orgUnitId,
    ).toBe(ids.care);

    await patch(`/api/admin/users/${ids.user}/details`, { orgUnitId: null });
    expect(
      (
        await withTenant(ctx.tenantId, (tx) =>
          tx.user.findUniqueOrThrow({ where: { id: ids.user } }),
        )
      ).orgUnitId,
    ).toBeNull();
  });

  it('REFUSES an account owned by a directory source', async () => {
    const source = await makeSource();
    const userId = await withTenant(ctx.tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'adjoe',
        email: 'a@acme.test',
        displayName: 'AD Joe',
      });
      await tx.user.update({
        where: { id: u.id },
        data: { sourceId: source.id, sourceAnchor: 'cn=adjoe' },
      });
      return u.id;
    });
    const res = await patch(`/api/admin/users/${userId}/details`, {
      displayName: 'Renamed',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('https://syntra.dev/problems/source-owned');
  });

  it('leaves the password-source endpoint doing its own job', async () => {
    // Two endpoints on purpose. Folding where the PASSWORD lives in with a
    // display-name fix would put a change to how authentication works in the
    // same request and the same audit row as a typo correction.
    const userId = await withTenant(ctx.tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'jdoe',
        email: 'j@acme.test',
        displayName: 'J Doe',
      });
      return u.id;
    });
    const res = await patch(`/api/admin/users/${userId}`, {
      passwordSource: 'upstream',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().passwordSource).toBe('upstream');
  });
});

describe('editing a person', () => {
  it('corrects the names and clears an email', async () => {
    const personId = (
      await makePerson({
        givenName: 'Jo',
        familyName: 'Doe',
        businessEmail: 'wrong@acme.test',
      })
    ).id;

    const res = await patch(`/api/admin/persons/${personId}`, {
      givenName: 'Joanna',
      businessEmail: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      givenName: 'Joanna',
      familyName: 'Doe',
      businessEmail: null,
    });
  });

  it('marks externalId when another person already holds it', async () => {
    // It is the key a CSV import matches on. Two people sharing one makes the
    // next import update whichever it happens to find first.
    await makePerson({ givenName: 'A', familyName: 'One', externalId: 'E1' });
    const second = await makePerson({
      givenName: 'B',
      familyName: 'Two',
      externalId: 'E2',
    });

    const res = await patch(`/api/admin/persons/${second.id}`, { externalId: 'E1' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errors[0].path).toBe('externalId');
  });
});

describe('deleting an org unit', () => {
  const del = (url: string) =>
    ctx.app.inject({ method: 'DELETE', url, headers: { host: ctx.host, cookie } });

  it('deletes a unit that is empty', async () => {
    const unit = await withTenant(ctx.tenantId, (tx) => createOrgUnit(tx, 'Finance'));

    const res = await del(`/api/admin/org-units/${unit.id}`);

    expect(res.statusCode).toBe(204);
    await withTenant(ctx.tenantId, (tx) =>
      expect(tx.orgUnit.findUnique({ where: { id: unit.id } })).resolves.toBeNull(),
    );
  });

  it('refuses a unit that still holds users, and says how many', async () => {
    const unit = await withTenant(ctx.tenantId, async (tx) => {
      const created = await createOrgUnit(tx, 'Nursing');
      const user = await createUser(tx, {
        login: 'nurse',
        email: 'nurse@acme.test',
        displayName: 'Nurse',
      });
      await tx.user.update({ where: { id: user.id }, data: { orgUnitId: created.id } });
      return created;
    });

    const res = await del(`/api/admin/org-units/${unit.id}`);

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/1 user/);
    await withTenant(ctx.tenantId, (tx) =>
      expect(tx.orgUnit.findUnique({ where: { id: unit.id } })).resolves.not.toBeNull(),
    );
  });

  it('refuses a unit that still has child units', async () => {
    const parent = await withTenant(ctx.tenantId, async (tx) => {
      const created = await createOrgUnit(tx, 'Clinical');
      await createOrgUnit(tx, 'Theatres', created.id);
      return created;
    });

    const res = await del(`/api/admin/org-units/${parent.id}`);

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/1 child unit/);
  });

  it('counts a DEACTIVATED user as still occupying the unit', async () => {
    const unit = await withTenant(ctx.tenantId, async (tx) => {
      const created = await createOrgUnit(tx, 'Records');
      const user = await createUser(tx, {
        login: 'gone',
        email: 'gone@acme.test',
        displayName: 'Gone',
      });
      await tx.user.update({
        where: { id: user.id },
        data: { orgUnitId: created.id, status: 'inactive', statusReason: 'left' },
      });
      return created;
    });

    const res = await del(`/api/admin/org-units/${unit.id}`);

    // Emptiness is about occupancy, not activity. A deactivated user still
    // sits in the unit, and deleting around them orphans the row.
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/1 user/);
  });

  it('answers 404 for a unit that is not there', async () => {
    const res = await del('/api/admin/org-units/00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});
