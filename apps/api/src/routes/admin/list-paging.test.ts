import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createGroup,
  createPerson,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

// Copied from persons.test.ts rather than imported: that file does not export
// these, and a shared route-test harness is its own change.
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

const get = (url: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

beforeEach(async () => {
  ctx = await buildTestApp();
  await seedAdmin([
    PERMISSIONS.IDENTITY_READ,
    PERMISSIONS.DIRECTORY_READ,
  ]);
  cookie = await adminCookie();
  await withTenant(ctx.tenantId, async (tx) => {
    for (let i = 0; i < 4; i += 1) {
      await createPerson(tx, { givenName: `Given${i}`, familyName: `Family${i}` });
    }
    await createGroup(tx, 'Payroll', 'Finance systems');
  });
});

describe('GET /persons', () => {
  it('answers with a page and the envelope describing it', async () => {
    const res = await get('/api/admin/persons?pageSize=2&page=2');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.persons).toHaveLength(2);
    expect(body.total).toBe(4);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(2);
  });

  it('narrows to a search', async () => {
    const res = await get('/api/admin/persons?q=family2');
    expect(res.json().total).toBe(1);
  });

  it('treats an empty q as no search rather than as matching nothing', async () => {
    const res = await get('/api/admin/persons?q=');
    expect(res.json().total).toBe(4);
  });

  it('REJECTS a pageSize above the ceiling rather than clamping it', async () => {
    // Silently returning 50 to a caller who asked for 100000 is a client bug
    // nobody ever sees.
    const res = await get('/api/admin/persons?pageSize=100000');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a page of zero', async () => {
    const res = await get('/api/admin/persons?page=0');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /users', () => {
  it('pages, and still says which accounts are locked', async () => {
    const res = await get('/api/admin/users?pageSize=1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.users[0]).toHaveProperty('locked');
  });

  it('searches by login', async () => {
    const res = await get('/api/admin/users?q=admin');
    expect(res.json().total).toBe(1);
  });
});

describe('GET /directory/summary', () => {
  it('counts people and accounts on the server, where paging cannot skew them', async () => {
    const res = await get('/api/admin/directory/summary');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.people.total).toBe(4);
    expect(body.people.active).toBe(4);
    // The admin seeded for these tests is the only account.
    expect(body.accounts.total).toBe(1);
    expect(body.accounts.locked).toBe(0);
  });
});

describe('GET /directory/summary, with only half the permissions', () => {
  // The route declares two preHandlers. A test that only ever calls it holding
  // both cannot tell whether Fastify runs both or stops at the first -- and if
  // it stops, the route silently requires less than it says.
  beforeEach(async () => {
    ctx = await buildTestApp();
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    cookie = await adminCookie();
  });

  it('refuses an admin who may read accounts but not people', async () => {
    const res = await get('/api/admin/directory/summary');
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /groups', () => {
  it('pages, and searches name and description', async () => {
    const res = await get('/api/admin/groups?q=finance');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.pageSize).toBe(50);
  });

  it('rejects a status filter, which groups do not have', async () => {
    const res = await get('/api/admin/groups?status=active');
    expect(res.statusCode).toBe(400);
  });
});
