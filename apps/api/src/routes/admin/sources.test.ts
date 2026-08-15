import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  setPassword,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
};

async function adminCookie(permissions: Permission[]) {
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'a@acme.test',
      displayName: 'Admin',
    });
    await setPassword(tx, user.id, PASSWORD);
    const role = await createRole(tx, 'R', permissions);
    await assignRole(tx, user.id, role.id);
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('source administration', () => {
  it('creates a source without echoing the password', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('adminpassword');
  });

  it('refuses to create a source with only sync.read', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const res = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    expect(res.statusCode).toBe(403);
  });

  it('tests a connection and reports what it found', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    const res = await post(`/api/admin/sources/${created.json().id}/test`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().sampleCounts.user).toBeGreaterThan(0);
  });

  it('reports a bad credential as ok:false rather than a 500', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Bad',
      config,
      bindPassword: 'wrong-password',
    });

    const res = await post(`/api/admin/sources/${created.json().id}/test`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });
});

describe('runs', () => {
  async function seeded(cookie: string) {
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    const id = created.json().id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/sources/${id}/mappings`,
      headers: { host: ctx.host, cookie },
      payload: {
        rules: [
          { objectType: 'user', sourceAttribute: 'uid', targetField: 'login', transform: 'lowercase', isCorrelation: true },
          { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: false },
          { objectType: 'user', sourceAttribute: 'cn', targetField: 'displayName', transform: 'trim', isCorrelation: false },
          { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
        ],
      },
    });
    return id;
  }

  it('runs a preview and returns the proposed changes', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const id = await seeded(cookie);

    const run = await post(`/api/admin/sources/${id}/run`, cookie);
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe('previewed');

    const detail = await get(`/api/admin/sync-runs/${run.json().id}`, cookie);
    expect(detail.json().changes.length).toBeGreaterThan(0);
  });

  it('applies a run', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ, PERMISSIONS.DIRECTORY_READ]);
    const id = await seeded(cookie);
    const run = await post(`/api/admin/sources/${id}/run`, cookie);

    const applied = await post(`/api/admin/sync-runs/${run.json().id}/apply`, cookie);
    expect(applied.statusCode).toBe(200);

    const users = await get('/api/admin/users', cookie);
    expect(users.json().users.length).toBeGreaterThan(0);
  });

  it('refuses to apply with only sync.read', async () => {
    const manage = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const id = await seeded(manage);
    const run = await post(`/api/admin/sources/${id}/run`, manage);

    // A second administrator holding only read.
    await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'reader',
        email: 'r@acme.test',
        displayName: 'Reader',
      });
      await setPassword(tx, user.id, PASSWORD);
      const role = await createRole(tx, 'ReadOnly', [PERMISSIONS.SYNC_READ]);
      await assignRole(tx, user.id, role.id);
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'reader', password: PASSWORD },
    });
    const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${token}` },
      payload: { password: PASSWORD },
    });
    const readerCookie = `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;

    const res = await post(
      `/api/admin/sync-runs/${run.json().id}/apply`,
      readerCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it('returns a 404, not a 500, when applying a run that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await post(
      '/api/admin/sync-runs/00000000-0000-0000-0000-000000000000/apply',
      cookie,
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toContain('not-found');
  });

  it('refuses to apply a blocked run', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    // Filters that match nothing across both object types make the source
    // return zero records, which trips the guard's zero-records branch. The
    // fixture config here has no orgUnitSearchBase, so the org-unit search
    // never runs and zeroing these two filters is enough.
    const created = await post('/api/admin/sources', cookie, {
      name: 'Empty',
      config: {
        ...config,
        userFilter: '(objectClass=nothingAtAll)',
        groupFilter: '(objectClass=nothingAtAll)',
      },
      bindPassword: 'adminpassword',
    });
    const id = created.json().id;

    const run = await post(`/api/admin/sources/${id}/run`, cookie);
    expect(run.json().status).toBe('blocked');

    const res = await post(`/api/admin/sync-runs/${run.json().id}/apply`, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toContain('run-blocked');
  });
});

describe('skipping a change', () => {
  async function seededRun(cookie: string) {
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    const id = created.json().id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/sources/${id}/mappings`,
      headers: { host: ctx.host, cookie },
      payload: {
        rules: [
          { objectType: 'user', sourceAttribute: 'uid', targetField: 'login', transform: 'lowercase', isCorrelation: true },
          { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
        ],
      },
    });
    const run = await post(`/api/admin/sources/${id}/run`, cookie);
    const detail = await get(`/api/admin/sync-runs/${run.json().id}`, cookie);
    return { runId: run.json().id, changes: detail.json().changes };
  }

  it('skips a proposed change and records who did it', async () => {
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.AUDIT_READ,
    ]);
    const { runId, changes } = await seededRun(cookie);

    const res = await post(
      `/api/admin/sync-changes/${changes[0].id}/skip`,
      cookie,
    );
    expect(res.statusCode).toBe(204);

    const detail = await get(`/api/admin/sync-runs/${runId}`, cookie);
    const skipped = detail
      .json()
      .changes.find((c: { id: string }) => c.id === changes[0].id);
    expect(skipped.status).toBe('skipped');

    const audit = await get('/api/admin/audit', cookie);
    expect(
      audit
        .json()
        .events.some(
          (e: { action: string; targetId: string }) =>
            e.action === 'sync.skip_change' && e.targetId === changes[0].id,
        ),
    ).toBe(true);
  });

  it('refuses to rewrite an already applied change as skipped', async () => {
    // Marking an applied change `skipped` would make the run state that a
    // mutation which committed to the directory never happened.
    const cookie = await adminCookie([
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.DIRECTORY_READ,
    ]);
    const { runId, changes } = await seededRun(cookie);
    await post(`/api/admin/sync-runs/${runId}/apply`, cookie);

    const res = await post(
      `/api/admin/sync-changes/${changes[0].id}/skip`,
      cookie,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toContain('change-not-proposed');

    const detail = await get(`/api/admin/sync-runs/${runId}`, cookie);
    const still = detail
      .json()
      .changes.find((c: { id: string }) => c.id === changes[0].id);
    expect(still.status).toBe('applied');
  });

  it('returns a 404 for a change that does not exist', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await post(
      '/api/admin/sync-changes/00000000-0000-0000-0000-000000000000/skip',
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });
});
