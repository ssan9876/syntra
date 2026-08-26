import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  addRule,
  assignRole,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  countUnusedRecoveryCodes,
  createRole,
  createUser,
  generateRecoveryCodes,
  localMasterKeyProvider,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

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


/** The same master key buildTestApp configures, so the vault round-trips. */
const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

async function seedUser(opts: { admin?: boolean } = {}) {
  const user = await withTenant(ctx.tenantId, async (tx) => {
    const created = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPasswordHash(tx, created.id, PASSWORD_HASH);
    if (opts.admin) {
      const role = await createRole(tx, 'Owner', [
        PERMISSIONS.DIRECTORY_READ,
        PERMISSIONS.DIRECTORY_WRITE,
      ]);
      await assignRole(tx, created.id, role.id);
    }
    return created;
  });
  userId = user.id;
  return user;
}

const login = (password = PASSWORD) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'jdoe', password },
  });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'syntra_session')?.value;

async function portalCookie() {
  const res = await login();
  return cookieOf(res)!;
}

const call = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: object } = {},
) => {
  const headers: Record<string, string> = { host: ctx.host };
  if (opts.cookie) headers['cookie'] = `syntra_session=${opts.cookie}`;
  // Two calls rather than a spread: `exactOptionalPropertyTypes` will not let
  // a possibly-absent `payload` be handed to inject as `object | undefined`.
  return opts.payload === undefined
    ? ctx.app.inject({ method, url, headers })
    : ctx.app.inject({ method, url, headers, payload: opts.payload });
};

describe('TOTP enrolment over HTTP', () => {
  it('refuses without a session', async () => {
    await seedUser();
    const res = await call('POST', '/api/auth/mfa/totp/begin');
    expect(res.statusCode).toBe(401);
  });

  it('returns a secret and a QR image exactly once', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const res = await call('POST', '/api/auth/mfa/totp/begin', { cookie });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(body.qr).toMatch(/^data:image\/gif;base64,/);
  });

  it('confirms with a valid code and reports enrolment', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(begin.json().secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });

    const confirm = await call('POST', '/api/auth/mfa/totp/confirm', {
      cookie,
      payload: { code },
    });
    expect(confirm.statusCode).toBe(204);

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.json().totp.enrolled).toBe(true);
  });

  it('refuses a wrong confirmation code', async () => {
    await seedUser();
    const cookie = await portalCookie();
    await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    const confirm = await call('POST', '/api/auth/mfa/totp/confirm', {
      cookie,
      payload: { code: '000000' },
    });
    expect(confirm.statusCode).toBe(400);
  });

  it('never shows the secret again after enrolment', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    const secret = begin.json().secret;
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });
    await call('POST', '/api/auth/mfa/totp/confirm', { cookie, payload: { code } });

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.body).not.toContain(secret);
  });

  it('answers 409, not 500, when an authenticator app is already set up', async () => {
    // An unhandled throw out of the service layer would be a 500: it tells an
    // attacker the endpoint faulted and tells the user nothing they can act
    // on. The conflict has an action attached — remove the old one first.
    await seedUser();
    const cookie = await portalCookie();
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    await call('POST', '/api/auth/mfa/totp/confirm', {
      cookie,
      payload: {
        code: OTPAuth.TOTP.generate({
          secret: OTPAuth.Secret.fromBase32(begin.json().secret),
          period: 30,
          digits: 6,
          algorithm: 'SHA1',
        }),
      },
    });

    const again = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    expect(again.statusCode).toBe(409);
    expect(again.json().type).toBe('https://syntra.dev/problems/already-enrolled');
  });
});

describe('the step-up round trip', () => {
  /**
   * Enrols through the core service at a timestamp two minutes in the past,
   * not through HTTP at wall time.
   *
   * `confirmTotpEnrolment` sets the replay watermark to the counter step that
   * confirmed the enrolment — which is the point, since it stops the enrolment
   * code being replayed as a login. An HTTP enrolment followed immediately by
   * an HTTP sign-in lands in that same thirty-second step, so a correct code is
   * correctly refused and the test fails for a reason unrelated to what it is
   * testing. Backdating the confirmation puts the watermark four steps behind,
   * which makes the test deterministic rather than dependent on where in the
   * half-minute it happened to run.
   */
  async function enrolTotp(): Promise<string> {
    const past = new Date(Date.now() - 120_000);
    const enrolment = await withTenant(ctx.tenantId, (tx) =>
      beginTotpEnrolment(tx, provider, userId),
    );
    const ok = await confirmTotpEnrolment(
      ctx.tenantId,
      provider,
      userId,
      OTPAuth.TOTP.generate({
        secret: OTPAuth.Secret.fromBase32(enrolment.secret),
        period: 30,
        digits: 6,
        algorithm: 'SHA1',
        timestamp: past.getTime(),
      }),
      past,
    );
    expect(ok).toBe(true);
    return enrolment.secret;
  }

  it('answers a login with a challenge and no cookie, then a session on verify', async () => {
    await seedUser();
    const secret = await enrolTotp();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const challenge = await login();
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['totp'],
    });
    expect(cookieOf(challenge)).toBeUndefined();

    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });
    const verified = await call('POST', '/api/auth/mfa/verify', {
      payload: { type: 'totp', attemptToken: challenge.json().attemptToken, code },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ status: 'authenticated', scope: 'portal' });
    expect(cookieOf(verified)).toBeDefined();
  });

  it('offers a recovery code and no security key when that is all the user holds', async () => {
    // The screen believes this list. A user whose only remaining factor is a
    // printed code must not be shown a WebAuthn prompt for hardware they do
    // not have — and must not be shown an empty screen either.
    await seedUser();
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const challenge = await login();
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json().status).toBe('challenge');
    expect(challenge.json().acceptableFactors).toEqual(['recovery_code']);
  });

  it('never returns the attempt token in the verified response', async () => {
    await seedUser();
    const secret = await enrolTotp();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const challenge = await login();
    const token = challenge.json().attemptToken;
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });
    const verified = await call('POST', '/api/auth/mfa/verify', {
      payload: { type: 'totp', attemptToken: token, code },
    });
    expect(verified.body).not.toContain(token);
  });

  it('answers a bad code with 401 and no cookie', async () => {
    await seedUser();
    await enrolTotp();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const challenge = await login();

    const verified = await call('POST', '/api/auth/mfa/verify', {
      payload: {
        type: 'totp',
        attemptToken: challenge.json().attemptToken,
        code: '000000',
      },
    });
    expect(verified.statusCode).toBe(401);
    expect(cookieOf(verified)).toBeUndefined();
  });

  it('answers an unknown attempt token identically to a bad code', async () => {
    await seedUser();
    await enrolTotp();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const challenge = await login();

    const badCode = await call('POST', '/api/auth/mfa/verify', {
      payload: {
        type: 'totp',
        attemptToken: challenge.json().attemptToken,
        code: '000000',
      },
    });
    const badToken = await call('POST', '/api/auth/mfa/verify', {
      payload: { type: 'totp', attemptToken: 'nope', code: '000000' },
    });
    expect(badToken.statusCode).toBe(badCode.statusCode);
    expect(badToken.json()).toEqual(badCode.json());
  });
});

describe('recovery codes over HTTP', () => {
  /** Recovery codes need a real factor to be a fallback for. */
  async function withAFactor() {
    await seedUser();
    const past = new Date(Date.now() - 120_000);
    const enrolment = await withTenant(ctx.tenantId, (tx) =>
      beginTotpEnrolment(tx, provider, userId),
    );
    await confirmTotpEnrolment(
      ctx.tenantId,
      provider,
      userId,
      OTPAuth.TOTP.generate({
        secret: OTPAuth.Secret.fromBase32(enrolment.secret),
        period: 30,
        digits: 6,
        algorithm: 'SHA1',
        timestamp: past.getTime(),
      }),
      past,
    );
    return portalCookie();
  }

  it('refuses a user who holds no other factor', async () => {
    // Otherwise a user with nothing mints ten codes today, and a require_mfa
    // rule saved next month is satisfied by a printed code forever — the
    // forced-enrolment path is never reached and the rule buys the tenant
    // nothing.
    await seedUser();
    const cookie = await portalCookie();
    const res = await call('POST', '/api/auth/mfa/recovery-codes', { cookie });
    expect(res.statusCode).toBe(409);
    expect(await withTenant(ctx.tenantId, (tx) => tx.recoveryCode.count())).toBe(0);
  });

  it('issues ten codes and reports the remaining count', async () => {
    const cookie = await withAFactor();
    const res = await call('POST', '/api/auth/mfa/recovery-codes', { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().codes).toHaveLength(10);

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.json().recoveryCodes.remaining).toBe(10);
  });

  it('never returns the codes again', async () => {
    const cookie = await withAFactor();
    const codes = (await call('POST', '/api/auth/mfa/recovery-codes', { cookie })).json().codes;
    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.body).not.toContain(codes[0]);
  });

  it('mails the account owner when a factor is added', async () => {
    // The only control that reaches the person who can tell a legitimate
    // enrolment from an attacker's, and the reason it is unconditional: a
    // factor added with a stolen password survives the password reset that
    // would otherwise fix things.
    await seedUser();
    const cookie = await portalCookie();
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    await call('POST', '/api/auth/mfa/totp/confirm', {
      cookie,
      payload: {
        code: OTPAuth.TOTP.generate({
          secret: OTPAuth.Secret.fromBase32(begin.json().secret),
          period: 30,
          digits: 6,
          algorithm: 'SHA1',
        }),
      },
    });

    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0]!.to).toBe('j@acme.test');
    expect(ctx.mail.sent[0]!.subject).toContain('second factor');
  });
});

/** Enrols TOTP the way the browser does, so the user really holds a factor. */
async function enrolTotpOverHttp(cookie: string) {
  const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
  const code = OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(begin.json().secret),
    period: 30,
    digits: 6,
    algorithm: 'SHA1',
  });
  const confirm = await call('POST', '/api/auth/mfa/totp/confirm', {
    cookie,
    payload: { code },
  });
  expect(confirm.statusCode).toBe(204);
}

describe('administrative factor removal', () => {
  it('removes a user factor and writes an audit event', async () => {
    const admin = await seedUser({ admin: true });
    const cookie = await portalCookie();
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, admin.id));

    const elevated = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    const adminCookie = cookieOf(elevated)!;

    const res = await call('DELETE', `/api/admin/users/${admin.id}/factors/recovery_code`, {
      cookie: adminCookie,
    });
    expect(res.statusCode).toBe(200);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'mfa.removed' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('takes the recovery codes with the last real factor', async () => {
    // Recovery codes are the way back in when a factor is lost, which is why
    // issuing them requires already holding one. Leaving them behind here
    // reaches the state that gate exists to prevent: a require_mfa rule
    // satisfied by a printed page forever, with the forced-enrolment path
    // never reached.
    const admin = await seedUser({ admin: true });
    const cookie = await portalCookie();
    await enrolTotpOverHttp(cookie);
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, admin.id));

    const elevated = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });

    const res = await call('DELETE', `/api/admin/users/${admin.id}/factors/totp`, {
      cookie: cookieOf(elevated)!,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recoveryCodesRevoked: 10 });

    const left = await withTenant(ctx.tenantId, (tx) =>
      countUnusedRecoveryCodes(tx, admin.id),
    );
    expect(left).toBe(0);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'mfa.removed' } }),
    );
    expect(events.at(-1)!.payload).toMatchObject({ recoveryCodesRevoked: 10 });
  });

  it('leaves the recovery codes alone while another factor remains', async () => {
    const admin = await seedUser({ admin: true });
    const cookie = await portalCookie();
    await enrolTotpOverHttp(cookie);
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, admin.id));

    const elevated = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });

    // No security key was ever registered, so this removes nothing and the
    // TOTP factor still stands.
    const res = await call('DELETE', `/api/admin/users/${admin.id}/factors/webauthn`, {
      cookie: cookieOf(elevated)!,
    });
    expect(res.json()).toEqual({ recoveryCodesRevoked: 0 });

    const left = await withTenant(ctx.tenantId, (tx) =>
      countUnusedRecoveryCodes(tx, admin.id),
    );
    expect(left).toBe(10);
  });

  it('refuses a portal session', async () => {
    const user = await seedUser();
    const cookie = await portalCookie();
    const res = await call('DELETE', `/api/admin/users/${user.id}/factors/totp`, { cookie });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * A credential row, seeded rather than registered.
 *
 * Registering one over HTTP needs a real authenticator to sign the
 * attestation, which a test does not have; `admin/tenant.test.ts` seeds the
 * same way for the same reason. Bound through `withTenant` because row-level
 * security matches nothing outside a bound transaction, so an unbound create
 * would fail for a reason unrelated to what is under test.
 */
async function seedWebAuthnCredential(): Promise<string> {
  const row = await withTenant(ctx.tenantId, (tx) =>
    tx.webAuthnCredential.create({
      data: {
        tenantId: ctx.tenantId,
        userId,
        // The base64url handle the authenticator knows it by. The ROUTE takes
        // the row's own uuid, which is what this returns -- they are different
        // identifiers and only one of them parses as a uuid.
        credentialId: `cred-${userId}`,
        publicKey: Buffer.from([0]),
        counter: 0,
        rpId: ctx.host,
        label: 'YubiKey',
      },
    }),
  );
  return row.id;
}

describe('a factor leaving an account is told to its owner', () => {
  /**
   * Additions mail the owner deliberately: it is one of the two controls that
   * make "a stolen password can enrol a factor" an acceptable trade. Removal
   * needs only a session -- no current password, no step-up -- and cascades
   * recovery-code revocation, which is strictly the more damaging half, and it
   * told nobody at all. An attacker holding a session could quietly strip
   * every factor off an account and the owner would find out at their next
   * sign-in, with nothing to say what happened.
   */
  it('mails the owner when a security key is removed', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const credentialId = await seedWebAuthnCredential();

    const before = ctx.mail.sent.length;
    const res = await call('DELETE', `/api/auth/mfa/webauthn/${credentialId}`, { cookie });
    expect(res.statusCode).toBe(200);

    const sent = ctx.mail.sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('j@acme.test');
    expect(sent[0]!.text).toContain('security key');
  });

  /**
   * The count is on the wire because the console shows it. A user whose
   * printed codes have just been revoked has no other way to find that out.
   */
  it('answers how many recovery codes went with it', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const credentialId = await seedWebAuthnCredential();
    const issued = await call('POST', '/api/auth/mfa/recovery-codes', { cookie });

    const res = await call('DELETE', `/api/auth/mfa/webauthn/${credentialId}`, { cookie });
    expect(res.json()).toEqual({
      recoveryCodesRevoked: (issued.json() as { codes: string[] }).codes.length,
    });
  });
});

describe('removing an authenticator app', () => {
  /**
   * `POST /mfa/totp/begin` refuses with "Remove the existing one before
   * setting up another", and until this route existed nothing could. A person
   * who replaced their phone had to raise a ticket to use a control the rest
   * of this screen treats as self-service.
   */
  it('removes it, so a new one can be set up', async () => {
    await seedUser();
    const cookie = await portalCookie();
    await enrolTotpOverHttp(cookie);

    const removed = await call('DELETE', '/api/auth/mfa/totp', { cookie });
    expect(removed.statusCode).toBe(200);

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.json()).toMatchObject({ totp: { enrolled: false } });

    // And the refusal that motivated all of this is gone.
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    expect(begin.statusCode).toBe(200);
  });

  /**
   * Removing the last real factor takes the recovery codes with it, exactly as
   * the passkey removal does. Holding a factor is a precondition of issuing
   * codes; leaving them behind here reaches the state that gate exists to
   * prevent, from the other side.
   */
  it('revokes orphaned recovery codes and says how many', async () => {
    await seedUser();
    const cookie = await portalCookie();
    await enrolTotpOverHttp(cookie);
    const issued = await call('POST', '/api/auth/mfa/recovery-codes', { cookie });
    expect(issued.statusCode).toBe(200);

    const removed = await call('DELETE', '/api/auth/mfa/totp', { cookie });
    expect(removed.json()).toEqual({
      recoveryCodesRevoked: (issued.json() as { codes: string[] }).codes.length,
    });
    const remaining = await withTenant(ctx.tenantId, (tx) =>
      countUnusedRecoveryCodes(tx, userId),
    );
    expect(remaining).toBe(0);
  });

  it('refuses when nothing is enrolled, rather than reporting a removal', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const res = await call('DELETE', '/api/auth/mfa/totp', { cookie });
    expect(res.statusCode).toBe(409);
  });

  it('needs a session', async () => {
    await seedUser();
    const res = await call('DELETE', '/api/auth/mfa/totp', {});
    expect(res.statusCode).toBe(401);
  });
});
