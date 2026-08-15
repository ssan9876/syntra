import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  setPassword,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'correct horse battery staple';

async function seedUser(opts: { admin?: boolean } = {}) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, user.id, PASSWORD);
    if (opts.admin) {
      const role = await createRole(tx, 'Directory Admin', [
        PERMISSIONS.DIRECTORY_READ,
        PERMISSIONS.DIRECTORY_WRITE,
      ]);
      await assignRole(tx, user.id, role.id);
    }
    return user;
  });
}

const login = (password: string, name = 'jdoe') =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: name, password },
  });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'syntra_session');

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('POST /api/auth/login', () => {
  it('issues a portal session cookie on success', async () => {
    await seedUser();
    const res = await login(PASSWORD);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      scope: 'portal',
      mayElevate: false,
      displayName: 'J Doe',
    });

    const cookie = cookieOf(res) as
      | { httpOnly?: boolean; sameSite?: string; path?: string }
      | undefined;
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite?.toLowerCase()).toBe('lax');
    expect(cookie!.path).toBe('/');
  });

  it('never returns the session token in the response body', async () => {
    await seedUser();
    const res = await login(PASSWORD);
    const token = cookieOf(res)!.value;
    expect(res.body).not.toContain(token);
  });

  it('answers a wrong password with 401 and no cookie', async () => {
    await seedUser();
    const res = await login('wrong');

    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(
      'https://syntra.dev/problems/invalid-credentials',
    );
    expect(cookieOf(res)).toBeUndefined();
  });

  it('answers an unknown login with the same body as a wrong password', async () => {
    await seedUser();
    const wrong = await login('wrong');
    const unknown = await login('wrong', 'nobody');

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('answers a deactivated account the same way as a wrong password', async () => {
    const user = await seedUser();
    const { deactivateUser } = await import('@syntra/core');
    await withTenant(ctx.tenantId, (tx) =>
      deactivateUser(tx, user.id, 'left the company'),
    );

    const disabled = await login(PASSWORD);
    const wrong = await login('wrong');

    // The distinction is recorded in the audit log, not handed to the caller.
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toEqual(wrong.json());
  });

  it('rejects a malformed body with 400 rather than 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'jdoe' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/auth/session', () => {
  it('returns the caller with their permissions', async () => {
    await seedUser({ admin: true });
    const cookie = cookieOf(await login(PASSWORD))!;

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie.value}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      displayName: 'J Doe',
      mayElevate: true,
      scope: 'portal',
    });
    expect(res.json().permissions).toContain('directory.read');
  });

  it('returns 401 without a cookie', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: ctx.host },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a forged cookie', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: ctx.host, cookie: 'syntra_session=made-up' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/elevate', () => {
  it('exchanges an administrator portal session for an admin session', async () => {
    await seedUser({ admin: true });
    const before = cookieOf(await login(PASSWORD))!;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${before.value}` },
      payload: { password: PASSWORD },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe('admin');

    // A fresh token, so the elevated session cannot be confused with the
    // portal one it replaced.
    const after = cookieOf(res)!;
    expect(after.value).not.toBe(before.value);
  });

  it('refuses to elevate a user who holds no roles', async () => {
    await seedUser();
    const cookie = cookieOf(await login(PASSWORD))!;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie.value}` },
      payload: { password: PASSWORD },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe(
      'https://syntra.dev/problems/not-an-administrator',
    );
  });

  it('refuses to elevate without re-entering the password', async () => {
    await seedUser({ admin: true });
    const cookie = cookieOf(await login(PASSWORD))!;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie.value}` },
      payload: { password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to elevate without a session at all', async () => {
    await seedUser({ admin: true });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it('records an audit event for the elevation', async () => {
    await seedUser({ admin: true });
    const cookie = cookieOf(await login(PASSWORD))!;
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie.value}` },
      payload: { password: PASSWORD },
    });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.elevate' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('success');
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session so it no longer resolves', async () => {
    await seedUser();
    const cookie = cookieOf(await login(PASSWORD))!;
    const headers = {
      host: ctx.host,
      cookie: `syntra_session=${cookie.value}`,
    };

    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers,
    });
    expect(out.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers,
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  it('starts refusing repeated password attempts', async () => {
    await seedUser();

    let limited = 0;
    for (let i = 0; i < 15; i++) {
      const res = await login('wrong');
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
