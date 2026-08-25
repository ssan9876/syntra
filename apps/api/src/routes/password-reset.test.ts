import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { createUser, generateRecoveryCodes, hashPassword, setPasswordHash } from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;

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


beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  // The RP id assertion below needs the tenant's own domain, not a guess off
  // the Host header -- the endpoint under test is unauthenticated, and Host
  // is the one thing it must never trust.
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });
  userId = await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'jo.doe@acme.test',
      displayName: 'J Doe',
    });
    await setPasswordHash(tx, u.id, PASSWORD_HASH);
    return u.id;
  });
});

const post = (url: string, payload: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host },
    payload: payload as object,
  });

/** A live reset token for `userId`, read out of the memory transport. */
const liveResetToken = async () => {
  await post('/api/auth/password-reset/request', { login: 'jdoe' });
  return tokenFromMail();
};

const tokenFromMail = () => {
  const match = /token=([A-Za-z0-9_-]+)/.exec(ctx.mail.sent[0]?.text ?? '');
  return match![1]!;
};

describe('POST /api/auth/password-reset/request', () => {
  it('answers identically for a known and an unknown login', async () => {
    const known = await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const unknown = await post('/api/auth/password-reset/request', { login: 'nobody' });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
  });

  it('sends the mail for the known one only', async () => {
    await post('/api/auth/password-reset/request', { login: 'nobody' });
    expect(ctx.mail.sent).toHaveLength(0);
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    expect(ctx.mail.sent).toHaveLength(1);
  });

  it('answers a federated account the same way as any other', async () => {
    // Not a 409, not a redirect, not a different body. Anything that singled
    // this account out would announce both that it exists and that it is
    // federated, to anyone who can type a login name into the form.
    await withTenant(ctx.tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Entra ID' },
      }),
    );
    const upstream = await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const unknown = await post('/api/auth/password-reset/request', { login: 'nobody' });

    expect(upstream.statusCode).toBe(unknown.statusCode);
    expect(upstream.body).toBe(unknown.body);
    // The difference is in the inbox, where only the account owner sees it.
    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0]!.text).toContain('Entra ID');
  });
});

describe('POST /api/auth/password-reset/preflight', () => {
  it('reports the factor a token holder must present', async () => {
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await post('/api/auth/password-reset/request', { login: 'jdoe' });

    const res = await post('/api/auth/password-reset/preflight', {
      token: tokenFromMail(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      valid: true,
      requiresFactor: true,
      acceptableFactors: ['recovery_code'],
    });
  });

  it('reports an unusable token without saying why', async () => {
    const res = await post('/api/auth/password-reset/preflight', {
      token: 'never-issued',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      valid: false,
      requiresFactor: false,
      acceptableFactors: [],
    });
  });
});

describe('POST /api/auth/password-reset/complete', () => {
  it('sets the password and lets the user sign in with it', async () => {
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const res = await post('/api/auth/password-reset/complete', {
      token: tokenFromMail(),
      newPassword: 'a completely different passphrase',
    });
    expect(res.statusCode).toBe(204);

    const login = await post('/api/auth/login', {
      login: 'jdoe',
      password: 'a completely different passphrase',
    });
    expect(login.statusCode).toBe(200);
  });

  it('reports a weak password with a usable message', async () => {
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const res = await post('/api/auth/password-reset/complete', {
      token: tokenFromMail(),
      newPassword: 'short',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().type).toContain('weak-password');
    expect(res.json().detail).toBeTruthy();
  });

  it('reports a spent, expired or unknown token identically', async () => {
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const token = tokenFromMail();
    await post('/api/auth/password-reset/complete', {
      token,
      newPassword: 'a completely different passphrase',
    });

    const spent = await post('/api/auth/password-reset/complete', {
      token,
      newPassword: 'yet another passphrase entirely',
    });
    const unknown = await post('/api/auth/password-reset/complete', {
      token: 'never-issued',
      newPassword: 'yet another passphrase entirely',
    });
    expect(spent.statusCode).toBe(400);
    expect(spent.json()).toEqual(unknown.json());
  });

  it('refuses to reset past a second factor', async () => {
    const codes = await withTenant(ctx.tenantId, (tx) =>
      generateRecoveryCodes(tx, userId),
    );
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const token = tokenFromMail();

    const without = await post('/api/auth/password-reset/complete', {
      token,
      newPassword: 'a completely different passphrase',
    });
    expect(without.statusCode).toBe(400);
    expect(without.json().type).toContain('factor-required');

    // The old password still works, because nothing was changed.
    const stillOld = await post('/api/auth/login', { login: 'jdoe', password: PASSWORD });
    expect(stillOld.statusCode).toBe(200);

    const withFactor = await post('/api/auth/password-reset/complete', {
      token,
      newPassword: 'a completely different passphrase',
      factor: { type: 'recovery_code', code: codes[0]! },
    });
    expect(withFactor.statusCode).toBe(204);
  });

  it('signs every existing session out', async () => {
    const login = await post('/api/auth/login', { login: 'jdoe', password: PASSWORD });
    const cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;

    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    await post('/api/auth/password-reset/complete', {
      token: tokenFromMail(),
      newPassword: 'a completely different passphrase',
    });

    const probe = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
    });
    expect(probe.statusCode).toBe(401);
  });
});
/**
 * The endpoint that makes a passkey reset possible at all.
 *
 * Separate from `/api/auth/mfa/webauthn/challenge` rather than a flag on it,
 * because the two are authenticated by different credentials -- an attempt
 * token there, a reset token here -- and one endpoint taking either is how a
 * reset token comes to satisfy a rule written about a sign-in attempt.
 */
describe('POST /api/auth/password-reset/webauthn/challenge', () => {
  it('mints a challenge for the holder of a live reset token', async () => {
    const token = await liveResetToken();

    const res = await post('/api/auth/password-reset/webauthn/challenge', { token });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { challenge?: string; rpId?: string };
    expect(typeof body.challenge).toBe('string');
    // The RELYING PARTY IS THE TENANT'S, never the Host header. This endpoint
    // is unauthenticated; it is the last place that should trust one.
    expect(body.rpId).toBe(ctx.host);
  });

  it('refuses an unknown token in the same words as a spent one', async () => {
    const res = await post('/api/auth/password-reset/webauthn/challenge', {
      token: 'not-a-real-token',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: expect.stringContaining('invalid-reset-token'),
    });
  });
});
