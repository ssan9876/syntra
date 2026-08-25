import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  addRule,
  assignRole,
  createRole,
  createUser,
  generateRecoveryCodes,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import * as OTPAuth from 'otpauth';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'correct horse battery staple';

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


async function seedUser(opts: { admin?: boolean } = {}) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
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

describe('POST /api/auth/login and policy', () => {
  it('reports a policy denial exactly as it reports a wrong password', async () => {
    await seedUser();
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'No', outcome: 'deny' }),
    );

    const denied = await login(PASSWORD);
    const wrong = await login('definitely-not-the-password');

    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual(wrong.json());
    expect(
      denied.cookies.find((c) => c.name === 'syntra_session'),
    ).toBeUndefined();
  });

  it('marks a plain success as authenticated', async () => {
    await seedUser();
    const res = await login(PASSWORD);
    expect(res.json()).toMatchObject({
      status: 'authenticated',
      scope: 'portal',
    });
  });

  it('offers enrolment when the user holds no factor', async () => {
    // Task 4 asserted a refusal here, because no verifier was installed and
    // there was nothing to offer. Now there is, and refusing would lock out
    // everyone the first time a tenant turns MFA on.
    await seedUser();
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'MFA everywhere', outcome: 'require_mfa' }),
    );
    const res = await login(PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'enrol' });
    // The password was accepted; nothing else was granted.
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
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

  it("does not spend one tenant's allowance on another tenant's traffic", async () => {
    // One deployment serves many tenants and the limit is keyed on both, so a
    // tenant under attack — or with one noisy office NAT — must not lock
    // everybody else out from the same address.
    await seedUser();
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    expect(other.id).not.toBe(ctx.tenantId);

    for (let i = 0; i < 15; i++) await login('wrong');
    expect((await login('wrong')).statusCode).toBe(429);

    const elsewhere = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'other.syntra.test' },
      payload: { login: 'jdoe', password: 'wrong' },
    });
    expect(elsewhere.statusCode).toBe(401);
  });

  it('caps a tenant across every address, not only each one separately', async () => {
    // Spec section 12 asks for per-tenant AND per-IP. A wrong second factor
    // deliberately does not consume the attempt, so without this ceiling a
    // six-digit code is guessable at the per-address rate from as many
    // addresses as the attacker cares to rent.
    ctx = await buildTestApp({
      env: { AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_TENANT_MAX: '5' },
    });
    await ctx.app.ready();
    await seedUser();

    const fromAddress = (address: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: ctx.host },
        remoteAddress: address,
        payload: { login: 'jdoe', password: 'wrong' },
      });

    const codes: number[] = [];
    // Eight addresses, one attempt each: nothing here trips the per-address
    // limit of two, and only the tenant ceiling can refuse any of them.
    for (let i = 1; i <= 8; i++) {
      codes.push((await fromAddress(`203.0.113.${i}`)).statusCode);
    }

    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
  });
});

describe('the source address', () => {
  const attemptWithForwardedFor = async () => {
    await seedUser();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host, 'x-forwarded-for': '203.0.113.9' },
      remoteAddress: '10.9.9.9',
      payload: { login: 'jdoe', password: 'wrong' },
    });
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } }),
    );
    return events.at(-1)!.sourceIp;
  };

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    // The default. Believing the header from anyone lets every client choose
    // the address the policy engine matches its IP conditions against.
    expect(await attemptWithForwardedFor()).toBe('10.9.9.9');
  });

  it('reads it from the proxy when TRUST_PROXY says how many hops', async () => {
    ctx = await buildTestApp({ env: { TRUST_PROXY: '1' } });
    await ctx.app.ready();
    expect(await attemptWithForwardedFor()).toBe('203.0.113.9');
  });
});

describe('POST /api/auth/elevate and admin MFA', () => {
  it('elevates on the password alone when the tenant does not require a factor', async () => {
    await seedUser({ admin: true });
    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    expect(res.json()).toMatchObject({ status: 'authenticated', scope: 'admin' });
  });

  it('challenges instead when the tenant requires a factor for the console', async () => {
    const user = await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, user.id));

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    expect(res.json()).toMatchObject({ status: 'challenge' });
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });

  it('offers enrolment to an administrator who has no factor yet', async () => {
    await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    // Turning the requirement on must not strand the only administrator
    // outside the console with nobody able to let them back in.
    expect(res.json()).toMatchObject({ status: 'enrol' });
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });

  it('refuses outright when the tenant has also turned self-enrolment off', async () => {
    await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true, selfEnrolmentEnabled: false },
    });

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    // Two deliberate decisions stacked: factors are issued by hand, and the
    // console needs one. There is genuinely no path forward from here.
    expect(res.statusCode).toBe(401);
  });

  it('issues an admin session when an elevation enrolment completes', async () => {
    await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;
    const offer = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    const attemptToken = offer.json().attemptToken as string;

    const begin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/enrol/totp/begin',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { attemptToken },
    });
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(begin.json().secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });

    const done = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/enrol/totp/confirm',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { attemptToken, code },
    });
    // The caller already held a portal session, so the step-up ends in an
    // administrative one rather than a second portal session.
    expect(done.statusCode).toBe(200);
    expect(done.json().scope).toBe('admin');
  });

  it('issues an admin session when the challenge is answered', async () => {
    const user = await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });
    const codes = await withTenant(ctx.tenantId, (tx) =>
      generateRecoveryCodes(tx, user.id),
    );

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;
    const challenge = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });

    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: {
        type: 'recovery_code',
        attemptToken: challenge.json().attemptToken,
        code: codes[0],
      },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().scope).toBe('admin');
  });
});

/**
 * The wiring, not the derivation.
 *
 * `cookiesAreSecure` is unit-tested next to itself, but the defect this fixes
 * was never in the arithmetic -- it was that three cookie definitions read
 * `process.env.NODE_ENV`, a variable `config.ts` has no say in and the lab
 * deployment exports nowhere. A pure test of the helper would have passed
 * happily while every cookie still went out unmarked, so the assertion that
 * matters is made against a real response from a real app.
 */
describe('the session cookie takes Secure from PUBLIC_URL', () => {
  it('marks it Secure when the deployment is reached over https', async () => {
    ctx = await buildTestApp({ env: { PUBLIC_URL: `https://${TEST_HOST}` } });
    await ctx.app.ready();
    await seedUser();

    const cookie = cookieOf(await login(PASSWORD)) as unknown as { secure?: boolean };
    expect(cookie).toBeDefined();
    expect(cookie.secure).toBe(true);
  });

  /**
   * And plain HTTP must NOT, or a development server sets a cookie the browser
   * never sends back -- which reads as "sign-in is broken" rather than as a
   * cookie policy. This is also the behaviour the whole existing suite relies
   * on, which is what makes the swap safe.
   */
  it('leaves it unmarked on plain http', async () => {
    await seedUser();
    const cookie = cookieOf(await login(PASSWORD)) as unknown as { secure?: boolean };
    expect(cookie).toBeDefined();
    expect(cookie.secure).toBeFalsy();
  });
});
