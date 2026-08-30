import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  issueApiToken,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let serviceAccountId: string;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    if (permissions.length > 0) {
      const role = await createRole(tx, 'Custom', permissions);
      await assignRole(tx, user.id, role.id);
    }
    return user;
  });
}

async function adminCookie() {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: TEST_HOST },
    payload: { login: 'admin', password: PASSWORD },
  });
  let token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: TEST_HOST, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  token = up.cookies.find((c) => c.name === 'syntra_session')!.value;
  return `syntra_session=${token}`;
}

const url = () => `/api/admin/users/${serviceAccountId}/tokens`;

const call = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  cookie: string,
  payload?: unknown,
) =>
  ctx.app.inject({
    method,
    url: path,
    headers: { host: TEST_HOST, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const asToken = (token: string, method: 'GET' | 'POST', path: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url: path,
    headers: { host: TEST_HOST, authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  const svc = await withTenant(ctx.tenantId, (tx) =>
    createUser(tx, { login: 'svc', email: 'svc@acme.test', displayName: 'Service' }),
  );
  serviceAccountId = svc.id;
});

describe('issuing', () => {
  it('returns the token exactly once', async () => {
    await seedAdmin([PERMISSIONS.TOKEN_MANAGE]);
    const cookie = await adminCookie();

    const created = await call('POST', url(), cookie, { name: 'SCIM', scopes: [] });

    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    expect(token).toMatch(/^syntra_pat_/);

    // And never again, from any route.
    const listed = await call('GET', url(), cookie);
    expect(JSON.stringify(listed.json())).not.toContain(token);
  });

  it('needs token.manage, and directory.write is not enough', async () => {
    // Issuing a credential that ACTS AS an account is a different authority
    // from editing that account.
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await adminCookie();

    expect((await call('POST', url(), cookie, { name: 'x' })).statusCode).toBe(403);
  });

  it('refuses a scope that is not a real permission', async () => {
    // Otherwise it is a token that silently grants nothing, met later as a
    // 403 nobody can explain.
    await seedAdmin([PERMISSIONS.TOKEN_MANAGE]);
    const cookie = await adminCookie();

    const res = await call('POST', url(), cookie, {
      name: 'x',
      scopes: ['directory.reed'],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('directory.reed');
  });

  it('accepts a real permission as a scope', async () => {
    await seedAdmin([PERMISSIONS.TOKEN_MANAGE]);
    const cookie = await adminCookie();

    const res = await call('POST', url(), cookie, {
      name: 'x',
      scopes: [PERMISSIONS.DIRECTORY_READ],
    });

    expect(res.statusCode).toBe(201);
  });

  it('answers 404 for an account that does not exist', async () => {
    await seedAdmin([PERMISSIONS.TOKEN_MANAGE]);
    const cookie = await adminCookie();

    const res = await call(
      'POST',
      '/api/admin/users/00000000-0000-0000-0000-000000000001/tokens',
      cookie,
      { name: 'x' },
    );

    expect(res.statusCode).toBe(404);
  });

  it('audits the name and scopes and never the token', async () => {
    // An audit row is read by more people, and kept longer, than the
    // credential itself.
    await seedAdmin([PERMISSIONS.TOKEN_MANAGE]);
    const cookie = await adminCookie();

    const created = await call('POST', url(), cookie, {
      name: 'SCIM from Workday',
      scopes: [PERMISSIONS.DIRECTORY_READ],
    });
    const token = created.json().token as string;

    const event = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'api_token.issued' } }),
    );
    expect(JSON.stringify(event.payload)).not.toContain(token);
    expect(event.payload).toMatchObject({
      name: 'SCIM from Workday',
      scopes: [PERMISSIONS.DIRECTORY_READ],
    });
  });
});

describe('revoking', () => {
  it('stops the token working immediately', async () => {
    await seedAdmin([PERMISSIONS.TOKEN_MANAGE, PERMISSIONS.DIRECTORY_READ]);
    const cookie = await adminCookie();
    await withTenant(ctx.tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, serviceAccountId, role.id);
    });
    const created = await call('POST', url(), cookie, { name: 'x', scopes: [] });
    const { id, token } = created.json();

    expect((await asToken(token, 'GET', '/api/admin/users')).statusCode).toBe(200);

    expect((await call('DELETE', `${url()}/${id}`, cookie)).statusCode).toBe(204);

    expect((await asToken(token, 'GET', '/api/admin/users')).statusCode).toBe(401);
  });

  it('answers 404 for a token belonging to another account', async () => {
    // A token id on its own is not a capability to revoke anything in the
    // tenant.
    await seedAdmin([PERMISSIONS.TOKEN_MANAGE]);
    const cookie = await adminCookie();
    const other = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, { login: 'other', email: 'other@acme.test', displayName: 'Other' }),
    );
    const theirs = await withTenant(ctx.tenantId, (tx) =>
      issueApiToken(tx, {
        userId: other.id,
        name: 'theirs',
        scopes: [],
        expiresAt: null,
        createdBy: null,
      }),
    );

    const res = await call('DELETE', `${url()}/${theirs.id}`, cookie);

    expect(res.statusCode).toBe(404);
  });
});

describe('a token cannot manage tokens', () => {
  it('refuses to let a machine mint another machine credential', async () => {
    // A credential that can mint credentials is a credential whose revocation
    // does not end its authority: revoke the first, the second keeps working,
    // and nobody has any reason to go looking for it.
    const minter = await withTenant(ctx.tenantId, async (tx) => {
      const role = await createRole(tx, 'Tokens', [PERMISSIONS.TOKEN_MANAGE]);
      await assignRole(tx, serviceAccountId, role.id);
      return issueApiToken(tx, {
        userId: serviceAccountId,
        name: 'minter',
        scopes: [],
        expiresAt: null,
        createdBy: null,
      });
    });

    const res = await asToken(minter.token, 'POST', url(), { name: 'second', scopes: [] });

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toContain('token-not-accepted');
  });
});
