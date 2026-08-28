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
  // PATCH /persons/:id is gated on DIRECTORY_WRITE, not IDENTITY_WRITE, and
  // reading the unit list needs DIRECTORY_READ.
  const CAN: Permission[] = [
    ...BOTH,
    PERMISSIONS.DIRECTORY_READ,
    PERMISSIONS.DIRECTORY_WRITE,
  ];

  const seedUnit = () =>
    withTenant(ctx.tenantId, (tx) =>
      tx.orgUnit
        .create({ data: { tenantId: ctx.tenantId, name: 'Sales' } })
        .then((u) => u.id),
    );

  it('assigns and then clears the assignment', async () => {
    await seedAdmin(CAN);
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
    await seedAdmin(CAN);
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
    await seedAdmin(CAN);
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

/**
 * Correcting a contract, rather than adding a second one that says something
 * different about the person.
 */
describe('PATCH /api/admin/persons/:id/contracts/:sequence', () => {
  /** A person holding one primary contract, returned as their id. */
  async function personWithContract(cookie: string, contract: object = {}) {
    const person = await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
    });
    const id = person.json().id;
    await post(`/api/admin/persons/${id}/contracts`, cookie, {
      sequence: 1,
      isPrimary: true,
      startDate: '2026-01-01',
      ...contract,
    });
    return id;
  }

  it('corrects a contract in place', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const id = await personWithContract(cookie, { department: 'Slaes' });

    const res = await patch(`/api/admin/persons/${id}/contracts/1`, cookie, {
      department: 'Sales',
      jobTitle: 'Account Executive',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().department).toBe('Sales');
    expect(res.json().jobTitle).toBe('Account Executive');
    // Untouched fields survive a partial patch.
    expect(res.json().isPrimary).toBe(true);
  });

  it('clears a field with null', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const id = await personWithContract(cookie, { jobTitle: 'Temp' });

    const res = await patch(`/api/admin/persons/${id}/contracts/1`, cookie, {
      jobTitle: null,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().jobTitle).toBeNull();
  });

  it('demotes the incumbent when a second contract is promoted to primary', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const id = await personWithContract(cookie);
    await post(`/api/admin/persons/${id}/contracts`, cookie, {
      sequence: 2,
      isPrimary: false,
      startDate: '2026-02-01',
    });

    await patch(`/api/admin/persons/${id}/contracts/2`, cookie, {
      isPrimary: true,
    });

    const detail = await get(`/api/admin/persons/${id}`, cookie);
    const contracts = detail.json().contracts as {
      sequence: number;
      isPrimary: boolean;
    }[];
    // Two primary contracts would make `resolveContractForMapping` return
    // whichever the planner reached first, which is a claim mapping that
    // changes on its own.
    expect(contracts.find((c) => c.sequence === 1)!.isPrimary).toBe(false);
    expect(contracts.find((c) => c.sequence === 2)!.isPrimary).toBe(true);
  });

  it('refuses a patch with nothing in it', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const id = await personWithContract(cookie);

    const res = await patch(`/api/admin/persons/${id}/contracts/1`, cookie, {});

    expect(res.statusCode).toBe(400);
  });

  it('404s for a sequence this person does not hold', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const id = await personWithContract(cookie);

    const res = await patch(`/api/admin/persons/${id}/contracts/9`, cookie, {
      jobTitle: 'Ghost',
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses a caller without identity.write', async () => {
    await seedAdmin([PERMISSIONS.IDENTITY_READ]);
    const cookie = await adminCookie();

    const res = await patch(
      `/api/admin/persons/${crypto.randomUUID()}/contracts/1`,
      cookie,
      { jobTitle: 'Nope' },
    );

    expect(res.statusCode).toBe(403);
  });
});

/**
 * The unit chosen while onboarding somebody actually reaches them.
 *
 * The form has sent `orgUnitId` since it was written; the schema never
 * accepted it, so Zod stripped it on every request and `createPerson` never
 * saw one. The field asked which unit somebody belonged to, said in as many
 * words that it decided where their account would land, and dropped the
 * answer — so everybody onboarded through it fell to the fallback container.
 */
describe('placing a person while creating them', () => {
  it('records the org unit the request carried', async () => {
    await seedAdmin([...BOTH, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await adminCookie();
    const unit = await post('/api/admin/org-units', cookie, { name: 'Sales' });

    const res = await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
      orgUnitId: unit.json().id,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().orgUnitId).toBe(unit.json().id);
  });

  it('leaves the unit null when none was chosen', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();

    const res = await post('/api/admin/persons', cookie, {
      givenName: 'Sam',
      familyName: 'Roe',
    });

    // Null sends them to the template rather than to a unit nobody picked.
    expect(res.json().orgUnitId).toBeNull();
  });
});

/**
 * Creating somebody who looks like somebody already here.
 *
 * A warning and not a refusal: two real people share a name, and two people
 * cannot be merged afterwards — which is why the question is asked before.
 */
describe('duplicate people', () => {
  it('warns about a namesake, case-insensitively', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
    });

    const res = await post('/api/admin/persons', cookie, {
      givenName: 'maya',
      familyName: 'OKAFOR',
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().type).toMatch(/possible-duplicate/);
    expect(res.json().candidates).toHaveLength(1);
    expect(res.json().candidates[0]).toMatchObject({ givenName: 'Maya' });
  });

  it('warns on a shared work email under a different name', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
      businessEmail: 'm@acme.test',
    });

    const res = await post('/api/admin/persons', cookie, {
      givenName: 'Different',
      familyName: 'Name',
      businessEmail: 'M@acme.test',
    });

    expect(res.statusCode).toBe(409);
  });

  it('creates anyway when confirmed', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
    });

    const res = await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
      allowDuplicate: true,
    });

    expect(res.statusCode).toBe(201);
  });

  it('does not warn about an inactive namesake', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    const first = await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
    });
    await post(`/api/admin/persons/${first.json().id}/deactivate`, cookie, {
      reason: 'left the company',
    });

    const res = await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
    });

    // Their replacement is not a duplicate of them.
    expect(res.statusCode).toBe(201);
  });

  it('does not warn on a different person entirely', async () => {
    await seedAdmin(BOTH);
    const cookie = await adminCookie();
    await post('/api/admin/persons', cookie, {
      givenName: 'Maya',
      familyName: 'Okafor',
      businessEmail: 'm@acme.test',
    });

    const res = await post('/api/admin/persons', cookie, {
      givenName: 'Sam',
      familyName: 'Roe',
      businessEmail: 's@acme.test',
    });

    expect(res.statusCode).toBe(201);
  });
});
