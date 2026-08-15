import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { prisma, withTenant } from '@syntra/db';
import { addRule, createUser, generateRecoveryCodes, setPassword } from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;

const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  userId = await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
    return u.id;
  });
});

const post = (url: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url, headers: { host: ctx.host }, payload });

const login = () => post('/api/auth/login', { login: 'jdoe', password: PASSWORD });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'syntra_session');

const requireMfa = () =>
  withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

const codeFor = (secret: string) =>
  OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    period: 30,
    digits: 6,
    algorithm: 'SHA1',
  });

describe('a login that requires a factor the user does not hold', () => {
  it('answers with an enrolment demand and no cookie', async () => {
    await requireMfa();
    const res = await login();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'enrol' });
    expect(res.json().enrollableFactors).toEqual(
      expect.arrayContaining(['totp', 'webauthn']),
    );
    // The password was right, but nothing has been granted.
    expect(cookieOf(res)).toBeUndefined();
  });

  it('never offers recovery codes as the factor to enrol', async () => {
    await requireMfa();
    const res = await login();
    expect(res.json().enrollableFactors).not.toContain('recovery_code');
  });

  it('refuses outright when the tenant has turned self-enrolment off', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { selfEnrolmentEnabled: false },
    });
    await requireMfa();
    const res = await login();
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/enrol/totp', () => {
  async function offer() {
    await requireMfa();
    return login().then((res) => res.json().attemptToken as string);
  }

  it('refuses without an attempt token', async () => {
    const res = await post('/api/auth/enrol/totp/begin', { attemptToken: 'nope' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an ordinary session cookie in place of an attempt token', async () => {
    // Signing in normally and then calling the enrolment surface must not work:
    // this endpoint is guarded by the attempt, not by a session, and the two
    // are not interchangeable.
    const signedIn = await login();
    const cookie = cookieOf(signedIn)!.value;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/enrol/totp/begin',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { attemptToken: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns a secret and a QR image against a live attempt', async () => {
    const attemptToken = await offer();
    const res = await post('/api/auth/enrol/totp/begin', { attemptToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.json().qr).toMatch(/^data:image\/gif;base64,/);
  });

  it('issues a session once the code is confirmed', async () => {
    const attemptToken = await offer();
    const secret = (await post('/api/auth/enrol/totp/begin', { attemptToken })).json()
      .secret as string;

    const res = await post('/api/auth/enrol/totp/confirm', {
      attemptToken,
      code: codeFor(secret),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'authenticated', scope: 'portal' });
    expect(cookieOf(res)).toBeDefined();
  });

  it('records the enrolment as having happened under a forced challenge', async () => {
    const attemptToken = await offer();
    const secret = (await post('/api/auth/enrol/totp/begin', { attemptToken })).json()
      .secret as string;
    await post('/api/auth/enrol/totp/confirm', { attemptToken, code: codeFor(secret) });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'mfa.enrolled' } }),
    );
    expect(events).toHaveLength(1);
    // A factor enrolled by whoever held the password during a forced challenge
    // must be distinguishable afterwards from one the owner added themselves.
    expect(events[0]!.payload).toMatchObject({
      factor: 'totp',
      underForcedEnrolment: true,
    });

    const completed = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.count({ where: { action: 'auth.forced_enrolment_completed' } }),
    );
    expect(completed).toBe(1);
  });

  it('refuses a wrong code and leaves the attempt usable', async () => {
    const attemptToken = await offer();
    const secret = (await post('/api/auth/enrol/totp/begin', { attemptToken })).json()
      .secret as string;

    const bad = await post('/api/auth/enrol/totp/confirm', {
      attemptToken,
      code: '000000',
    });
    expect(bad.statusCode).toBe(400);
    expect(cookieOf(bad)).toBeUndefined();

    const good = await post('/api/auth/enrol/totp/confirm', {
      attemptToken,
      code: codeFor(secret),
    });
    expect(good.statusCode).toBe(200);
  });

  it('refuses to reuse the attempt token after it has been spent', async () => {
    const attemptToken = await offer();
    const secret = (await post('/api/auth/enrol/totp/begin', { attemptToken })).json()
      .secret as string;
    await post('/api/auth/enrol/totp/confirm', { attemptToken, code: codeFor(secret) });

    const again = await post('/api/auth/enrol/totp/begin', { attemptToken });
    expect(again.statusCode).toBe(401);
  });

  it('refuses to spend a verification attempt on enrolment', async () => {
    // Give the user a factor, so the login produces a step-up challenge rather
    // than an enrolment demand, then try to use that token here.
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await requireMfa();
    const challenge = await login();
    expect(challenge.json().status).toBe('challenge');

    const res = await post('/api/auth/enrol/totp/begin', {
      attemptToken: challenge.json().attemptToken,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses TOTP when the rule names WebAuthn', async () => {
    // A require_factor: webauthn rule is refused at write time unless the
    // tenant has a primary domain set — the relying party is derived from it.
    // Setting it here, rather than loosening the guard, is what the brief for
    // this task calls out explicitly.
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: ctx.host },
    });
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'Keys', outcome: 'require_factor', factorType: 'webauthn' }),
    );
    const attemptToken = (await login()).json().attemptToken as string;
    const res = await post('/api/auth/enrol/totp/begin', { attemptToken });
    expect(res.statusCode).toBe(400);
  });
});
