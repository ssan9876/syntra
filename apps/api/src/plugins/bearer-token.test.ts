import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  issueApiToken,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';
import { routeRefusesTokens } from './bearer-token.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

/** A service account holding `permissions`, and a token for it. */
async function serviceAccount(permissions: Permission[], scopes: string[] = []) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: `svc-${Math.random().toString(36).slice(2, 8)}`,
      email: `svc-${Math.random().toString(36).slice(2, 8)}@acme.test`,
      displayName: 'Service',
    });
    if (permissions.length > 0) {
      const role = await createRole(tx, `Role ${user.login}`, permissions);
      await assignRole(tx, user.id, role.id);
    }
    const issued = await issueApiToken(tx, {
      userId: user.id,
      name: 'test',
      scopes,
      expiresAt: null,
      createdBy: null,
    });
    return { user, token: issued.token };
  });
}

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: TEST_HOST, authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('routeRefusesTokens', () => {
  it('refuses the authentication, portal and password families', () => {
    expect(routeRefusesTokens('/api/auth/elevate')).toBe(true);
    expect(routeRefusesTokens('/api/portal/applications')).toBe(true);
    expect(routeRefusesTokens('/api/admin/users/:id/password')).toBe(true);
  });

  it('allows the ordinary admin routes', () => {
    expect(routeRefusesTokens('/api/admin/users')).toBe(false);
    expect(routeRefusesTokens('/api/admin/groups')).toBe(false);
  });

  it('says no for a request that matched no route at all', () => {
    // A 404 has no pattern. Treating undefined as "refused" would be
    // harmless; treating it as "allowed" is what this asserts, because the
    // request is about to 404 anyway and inventing a 403 would be noise.
    expect(routeRefusesTokens(undefined)).toBe(false);
  });
});

describe('presenting a token', () => {
  it('reaches an admin route with the right permission', async () => {
    const { token } = await serviceAccount([PERMISSIONS.DIRECTORY_READ]);

    expect((await call('GET', '/api/admin/users', token)).statusCode).toBe(200);
  });

  it('is refused without the permission', async () => {
    const { token } = await serviceAccount([]);

    expect((await call('GET', '/api/admin/users', token)).statusCode).toBe(403);
  });

  it('does not need an elevated session', async () => {
    // A person needs to elevate to reach the console. A token cannot, and is
    // not asked to -- the routes it reaches ARE the administrative ones.
    const { token } = await serviceAccount([PERMISSIONS.DIRECTORY_READ]);

    const res = await call('GET', '/api/admin/users', token);

    expect(res.statusCode).not.toBe(403);
  });

  it('is unauthenticated when the token is unknown', async () => {
    expect((await call('GET', '/api/admin/users', 'syntra_pat_nope')).statusCode).toBe(401);
  });

  it('ignores a bearer value that is not one of ours', async () => {
    // An OAuth access token presented here by mistake is not something to
    // hash and look up.
    expect((await call('GET', '/api/admin/users', 'ya29.a0Af')).statusCode).toBe(401);
  });
});

describe('the routes a token cannot reach', () => {
  it('refuses elevation, whatever the token holds', async () => {
    // A token that could elevate would be a token that could mint a session,
    // which is a credential upgrade.
    const { token } = await serviceAccount([...ALL_PERMISSIONS]);

    const res = await call('POST', '/api/auth/elevate', token, { password: PASSWORD });

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toContain('token-not-accepted');
  });

  it('refuses setting a person\'s password', async () => {
    // Handing a program the ability to set a human's credential is a
    // different authority from managing the directory.
    const { token } = await serviceAccount([...ALL_PERMISSIONS]);
    const victim = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, { login: 'ada', email: 'ada@acme.test', displayName: 'Ada' }),
    );

    const res = await call('POST', `/api/admin/users/${victim.id}/password`, token, {
      password: 'a-brand-new-password',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toContain('token-not-accepted');
  });

  it('refuses the portal', async () => {
    const { token } = await serviceAccount([...ALL_PERMISSIONS]);

    expect((await call('GET', '/api/portal/applications', token)).statusCode).toBe(403);
  });

  it('refuses with 403 and never 401, because the credential was fine', async () => {
    // 401 would send an integrator to check a token that is perfectly good.
    const { token } = await serviceAccount([...ALL_PERMISSIONS]);

    const res = await call('POST', '/api/auth/elevate', token, { password: PASSWORD });

    expect(res.statusCode).not.toBe(401);
  });
});

describe('a cookie beats a header', () => {
  it('uses the session when the request carries both', async () => {
    // A browser that holds both is a browser. Letting a header override its
    // session would be a way to act as somebody else from inside their tab.
    await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'person',
        email: 'person@acme.test',
        displayName: 'A Person',
      });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: TEST_HOST },
      payload: { login: 'person', password: PASSWORD },
    });
    const cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    const { token } = await serviceAccount([...ALL_PERMISSIONS]);

    // The person holds no permissions; the token holds all of them. If the
    // header won, this would be a 200.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: {
        host: TEST_HOST,
        cookie: `syntra_session=${cookie}`,
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('using a token', () => {
  it('records it as used', async () => {
    const { token } = await serviceAccount([PERMISSIONS.DIRECTORY_READ]);

    await call('GET', '/api/admin/users', token);

    const row = await withTenant(ctx.tenantId, (tx) => tx.apiToken.findFirstOrThrow());
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('does not record a REFUSED token as used', async () => {
    // A rejected credential must not look active on the screen an operator
    // uses to find dormant ones.
    const { user } = await serviceAccount([PERMISSIONS.DIRECTORY_READ]);
    const expired = await withTenant(ctx.tenantId, (tx) =>
      issueApiToken(tx, {
        userId: user.id,
        name: 'expired',
        scopes: [],
        expiresAt: new Date(Date.now() - 1000),
        createdBy: null,
      }),
    );

    await call('GET', '/api/admin/users', expired.token);

    const row = await withTenant(ctx.tenantId, (tx) =>
      tx.apiToken.findFirstOrThrow({ where: { id: expired.id } }),
    );
    expect(row.lastUsedAt).toBeNull();
  });
});

describe('the intersection of account and token', () => {
  const listUsers = (token: string) => call('GET', '/api/admin/users', token);

  it('allows what both the account and the token hold', async () => {
    const { token } = await serviceAccount(
      [PERMISSIONS.DIRECTORY_READ],
      [PERMISSIONS.DIRECTORY_READ],
    );

    expect((await listUsers(token)).statusCode).toBe(200);
  });

  it('refuses what the token does not hold, though the account does', async () => {
    // A token minted for one job must not quietly do everything its account
    // can, or one over-broad account becomes many over-broad credentials.
    const { token } = await serviceAccount(
      [PERMISSIONS.DIRECTORY_READ, PERMISSIONS.RBAC_MANAGE],
      [PERMISSIONS.RBAC_MANAGE],
    );

    expect((await listUsers(token)).statusCode).toBe(403);
  });

  it('refuses what the ACCOUNT does not hold, though the token names it', async () => {
    // THE case that proves this is an intersection and not a union. A union
    // passes here and hands the token authority nobody ever granted the
    // account it acts as.
    const { token } = await serviceAccount([], [PERMISSIONS.DIRECTORY_READ]);

    expect((await listUsers(token)).statusCode).toBe(403);
  });

  it('gives an empty scope list the account\'s own authority', async () => {
    const { token } = await serviceAccount([PERMISSIONS.DIRECTORY_READ], []);

    expect((await listUsers(token)).statusCode).toBe(200);
  });

  it('loses the authority when the account\'s role is revoked, with no token change', async () => {
    // What makes offboarding an integration one act rather than a hunt
    // through its credentials.
    const { user, token } = await serviceAccount(
      [PERMISSIONS.DIRECTORY_READ],
      [PERMISSIONS.DIRECTORY_READ],
    );
    expect((await listUsers(token)).statusCode).toBe(200);

    await withTenant(ctx.tenantId, async (tx) => {
      await tx.roleAssignment.deleteMany({ where: { userId: user.id } });
    });

    expect((await listUsers(token)).statusCode).toBe(403);
  });

  it('leaves a cookie session unaffected by scopes', async () => {
    // A person's session has no second bound; tokenScopes is empty for it and
    // must not become a filter on their own permissions.
    await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'admin2',
        email: 'admin2@acme.test',
        displayName: 'Admin',
      });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, user.id, role.id);
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: TEST_HOST },
      payload: { login: 'admin2', password: PASSWORD },
    });
    let cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    cookie = up.cookies.find((c) => c.name === 'syntra_session')!.value;

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });

    expect(res.statusCode).toBe(200);
  });
});
