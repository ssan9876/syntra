import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'a-long-enough-password';

/**
 * Hashed once for the whole file, outside every transaction.
 *
 * There is no helper that takes a plaintext and a transaction any more:
 * Argon2id is deliberately expensive and has no business inside Prisma's
 * 5000 ms budget, so `setPasswordHash` takes a hash and the hashing is the
 * caller's to place. Hashing once per file rather than once per test is the
 * same decision made cheaply.
 */
const PASSWORD_HASH = await hashPassword(PASSWORD);

const HEADER =
  'externalId,givenName,familyName,businessEmail,sequence,isPrimary,startDate,endDate,jobTitle,department';

async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Custom', permissions);
    await assignRole(tx, user.id, role.id);
    return user;
  });
}

async function adminCookie() {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const post = (url: string, cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

const patch = (url: string, cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PATCH',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const BOTH: Permission[] = [
  PERMISSIONS.IDENTITY_READ,
  PERMISSIONS.IDENTITY_WRITE,
];

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('person administration', () => {
  it('creates a person', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();

    const res = await post('/api/admin/persons', cookie, {
      givenName: 'Jo',
      familyName: 'Doe',
      externalId: 'E1',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().givenName).toBe('Jo');
  });

  it('rejects a duplicate external id with 409', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const payload = { givenName: 'Jo', familyName: 'Doe', externalId: 'E1' };

    await post('/api/admin/persons', cookie, payload);
    const second = await post('/api/admin/persons', cookie, payload);
    expect(second.statusCode).toBe(409);
  });

  it('shows every contract on the detail view, not only the primary', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();

    const person = await post('/api/admin/persons', cookie, {
      givenName: 'Jo',
      familyName: 'Doe',
    });
    const id = person.json().id;

    await post(`/api/admin/persons/${id}/contracts`, cookie, {
      sequence: 1,
      isPrimary: true,
      startDate: '2026-01-01',
      jobTitle: 'Nurse',
    });
    await post(`/api/admin/persons/${id}/contracts`, cookie, {
      sequence: 2,
      startDate: '2026-03-01',
      jobTitle: 'Trainer',
    });

    const detail = await get(`/api/admin/persons/${id}`, cookie);
    expect(detail.json().contracts).toHaveLength(2);
    expect(
      detail.json().contracts.map((c: { jobTitle: string }) => c.jobTitle),
    ).toEqual(['Nurse', 'Trainer']);
  });

  it('refuses a second primary contract with 409 rather than a 500', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();

    const person = await post('/api/admin/persons', cookie, {
      givenName: 'Jo',
      familyName: 'Doe',
    });
    const id = person.json().id;

    await post(`/api/admin/persons/${id}/contracts`, cookie, {
      sequence: 1,
      isPrimary: true,
      startDate: '2026-01-01',
    });
    const second = await post(`/api/admin/persons/${id}/contracts`, cookie, {
      sequence: 2,
      isPrimary: true,
      startDate: '2026-01-01',
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().detail).toMatch(/primary contract/i);
  });

  it('links a user to a person', async () => {
    const admin = await seedAdmin([...BOTH, PERMISSIONS.DIRECTORY_READ]);
    const cookie = await adminCookie();

    const person = await post('/api/admin/persons', cookie, {
      givenName: 'Jo',
      familyName: 'Doe',
    });
    const id = person.json().id;

    const link = await post(`/api/admin/persons/${id}/link-user`, cookie, {
      userId: admin.id,
    });
    expect(link.statusCode).toBe(204);

    const detail = await get(`/api/admin/persons/${id}`, cookie);
    expect(detail.json().users).toHaveLength(1);
    expect(detail.json().users[0].login).toBe('admin');
  });

  it('returns 404 for a person that does not exist', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();

    const res = await get(
      '/api/admin/persons/00000000-0000-4000-8000-000000000000',
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('CSV import', () => {
  it('imports a valid file', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();

    const res = await post('/api/admin/persons/import', cookie, {
      csv: `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 1, updated: 0, errors: [] });
  });

  it('reports the rejected lines alongside what was imported', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();

    const res = await post('/api/admin/persons/import', cookie, {
      csv:
        `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care\n` +
        `E2,Sam,Roe,sam@acme.test,x,false,2026-01-01,,Trainer,Care`,
    });

    // A partial import that silently drops rows is the worst outcome for an
    // identity system: the operator must see exactly what did not land.
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(1);
    expect(res.json().errors).toEqual([
      { line: 3, message: 'sequence is not an integer' },
    ]);
  });

  it('refuses a file with nothing usable in it', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();

    const res = await post('/api/admin/persons/import', cookie, {
      csv: 'givenName,familyName\nJo,Doe',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().type).toBe('https://syntra.dev/problems/csv-invalid');
    expect(res.json().errors.length).toBeGreaterThan(0);
  });

  it('is idempotent when the same file is imported twice', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const csv = `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`;

    await post('/api/admin/persons/import', cookie, { csv });
    const second = await post('/api/admin/persons/import', cookie, { csv });

    expect(second.json()).toMatchObject({ created: 0, updated: 1 });
    const list = await get('/api/admin/persons', cookie);
    expect(list.json().persons).toHaveLength(1);
  });

  it('refuses to import with only identity.read', async () => {
    await seedAdmin([PERMISSIONS.IDENTITY_READ]);
    const cookie = await adminCookie();

    const res = await post('/api/admin/persons/import', cookie, {
      csv: `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('assigning a person to an org unit', () => {
  const seedUnit = () =>
    withTenant(ctx.tenantId, (tx) =>
      tx.orgUnit
        .create({ data: { tenantId: ctx.tenantId, name: 'Sales' } })
        .then((u) => u.id),
    );

  it('assigns and then clears the assignment', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const orgUnitId = await seedUnit();
    const person = await post('/api/admin/persons', cookie, {
      givenName: 'Jo',
      familyName: 'Doe',
    });
    const personId = person.json().id;

    const assigned = await patch(`/api/admin/persons/${personId}`, cookie, {
      orgUnitId,
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().orgUnitId).toBe(orgUnitId);

    // An explicit null clears it and sends this person back to the template.
    // Omitting the field would leave the assignment alone, which is why the
    // schema distinguishes the two.
    const cleared = await patch(`/api/admin/persons/${personId}`, cookie, {
      orgUnitId: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().orgUnitId).toBeNull();
  });

  it('leaves the assignment alone when the field is omitted', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const orgUnitId = await seedUnit();
    const person = await post('/api/admin/persons', cookie, {
      givenName: 'Jo',
      familyName: 'Doe',
    });
    const personId = person.json().id;
    await patch(`/api/admin/persons/${personId}`, cookie, { orgUnitId });

    const renamed = await patch(`/api/admin/persons/${personId}`, cookie, {
      givenName: 'Joanna',
    });

    expect(renamed.json().orgUnitId).toBe(orgUnitId);
  });

  it('refuses an org unit id that is not a uuid', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const person = await post('/api/admin/persons', cookie, {
      givenName: 'Jo',
      familyName: 'Doe',
    });

    const res = await patch(`/api/admin/persons/${person.json().id}`, cookie, {
      orgUnitId: 'Sales',
    });

    expect(res.statusCode).toBe(400);
  });
});
