import { beforeEach, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import * as OTPAuth from 'otpauth';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { notificationsSettled } from '../notify/delivery.js';
import { memoryTransport } from '../notify/notification-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createSession, resolveSession } from './session-service.js';
import { setPassword, verifyPassword } from './password.js';
import {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  installTotpVerifier,
} from './mfa/totp.js';
import { generateRecoveryCodes, installRecoveryCodeVerifier } from './mfa/recovery-codes.js';
import {
  completePasswordReset,
  preflightPasswordReset,
  requestPasswordReset,
  RESET_REQUEST_FLOOR_MS,
} from './password-reset.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };

let tenantId: string;
let userId: string;
let transport: ReturnType<typeof memoryTransport>;

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';
const PUBLIC_URL = 'http://acme.syntra.test';
const NOW = new Date('2026-08-12T09:00:00Z');

/**
 * The registry is module state shared by the whole fork, and another suite
 * clears it. Installing per test rather than once at import keeps this suite
 * from proving nothing because of what ran before it.
 */
beforeEach(async () => {
  installTotpVerifier(provider);
  installRecoveryCodeVerifier();

  await resetDatabase();
  transport = memoryTransport();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'jo.doe@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
    return u.id;
  });
});

/**
 * `floorMs` is dropped to something negligible everywhere except the one test
 * that is about the floor. Paying a quarter of a second per case to re-prove
 * the same `sleep` would be twenty-odd seconds of suite time for nothing.
 */
const request = (login: string, floorMs = 1) =>
  requestPasswordReset(tenantId, transport, PUBLIC_URL, {
    login,
    sourceIp: '10.1.2.3',
    now: NOW,
    floorMs,
  });

/** The token as it reaches the user: pulled out of the link in the mail. */
const tokenFromMail = () => {
  const match = /token=([A-Za-z0-9_-]+)/.exec(transport.sent[0]?.text ?? '');
  return match?.[1] ?? null;
};

describe('requestPasswordReset', () => {
  it('mails a single-use link to a known login', async () => {
    await request('jdoe');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('jo.doe@acme.test');
    expect(tokenFromMail()).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('accepts an email address as well as a login', async () => {
    await request('jo.doe@acme.test');
    expect(transport.sent).toHaveLength(1);
  });

  it('sends nothing for an unknown login, and does not throw', async () => {
    await request('nobody');
    expect(transport.sent).toHaveLength(0);
  });

  it('stores only the digest of the token', async () => {
    await request('jdoe');
    const token = tokenFromMail()!;
    const rows = await withTenant(tenantId, (tx) => tx.passwordResetToken.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('invalidates the previous token when a second is asked for', async () => {
    await request('jdoe');
    const first = tokenFromMail()!;
    await request('jdoe');

    const outcome = await completePasswordReset(tenantId, transport, {
      token: first,
      newPassword: NEW_PASSWORD,
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('does not fail when two requests for the same account race', async () => {
    // One of the two loses the partial unique index. A 500 there would be an
    // account-existence oracle built out of an error page: an unknown login
    // gets a 202 under exactly the same double-click.
    await Promise.all([request('jdoe'), request('jdoe')]);
    const live = await withTenant(tenantId, (tx) =>
      tx.passwordResetToken.count({ where: { consumedAt: null } }),
    );
    expect(live).toBe(1);
  });

  it('tells an upstream-managed user where to go instead, by mail', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Entra ID' },
      }),
    );
    await request('jdoe');

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toContain('Entra ID');
    expect(tokenFromMail()).toBeNull();
    expect(await withTenant(tenantId, (tx) => tx.passwordResetToken.count())).toBe(0);
  });

  it('sends nothing to an inactive account', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: userId }, data: { status: 'inactive' } }),
    );
    await request('jdoe');
    expect(transport.sent).toHaveLength(0);
  });

  it('records the request in the audit log either way', async () => {
    await request('jdoe');
    await request('nobody');
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.password_reset_requested' } }),
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.outcome).sort()).toEqual(['failure', 'success']);
  });

  it('takes the same time whether the account exists, is upstream, or does not', async () => {
    // Spec section 11 asks for a uniform response *and timing*. The body and
    // the status were already identical; without the floor the known branch
    // does two more round trips than the unknown one, which is a difference an
    // attacker averages away in a few hundred samples.
    const time = async (login: string) => {
      const started = performance.now();
      await request(login, RESET_REQUEST_FLOOR_MS);
      return performance.now() - started;
    };

    const known = await time('jdoe');
    const unknown = await time('nobody');

    await withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Entra ID' },
      }),
    );
    const upstream = await time('jdoe');

    for (const measured of [known, unknown, upstream]) {
      expect(measured).toBeGreaterThanOrEqual(RESET_REQUEST_FLOOR_MS - 5);
    }
    // Dominated by the floor rather than by what each branch actually did.
    const spread = Math.max(known, unknown, upstream) - Math.min(known, unknown, upstream);
    expect(spread).toBeLessThan(RESET_REQUEST_FLOOR_MS / 2);
  });
});

describe('preflightPasswordReset', () => {
  it('reports a valid token with no factor needed', async () => {
    await request('jdoe');
    expect(await preflightPasswordReset(tenantId, tokenFromMail()!, NOW)).toEqual({
      valid: true,
      requiresFactor: false,
      acceptableFactors: [],
    });
  });

  it('reports the factors a user with MFA must present', async () => {
    const enrolment = await withTenant(tenantId, (tx) =>
      beginTotpEnrolment(tx, provider, userId),
    );
    await confirmTotpEnrolment(
      tenantId,
      provider,
      userId,
      OTPAuth.TOTP.generate({
        secret: OTPAuth.Secret.fromBase32(enrolment.secret),
        period: 30,
        digits: 6,
        algorithm: 'SHA1',
        timestamp: NOW.getTime(),
      }),
      NOW,
    );
    await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));

    await request('jdoe');
    expect(await preflightPasswordReset(tenantId, tokenFromMail()!, NOW)).toEqual({
      valid: true,
      requiresFactor: true,
      acceptableFactors: ['totp', 'recovery_code'],
    });
  });

  it('reports an unknown token as invalid', async () => {
    expect(await preflightPasswordReset(tenantId, 'nope', NOW)).toEqual({ valid: false });
  });
});

describe('completePasswordReset', () => {
  const complete = (over: Record<string, unknown> = {}) =>
    completePasswordReset(tenantId, transport, {
      token: tokenFromMail()!,
      newPassword: NEW_PASSWORD,
      relyingParty: RP,
      sourceIp: '10.1.2.3',
      now: NOW,
      ...over,
    });

  it('sets the new password', async () => {
    await request('jdoe');
    expect(await complete()).toEqual({ ok: true });

    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(await verifyPassword(credential.hash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(credential.hash, PASSWORD)).toBe(false);
  });

  it('refuses the token a second time', async () => {
    await request('jdoe');
    const token = tokenFromMail()!;
    await complete({ token });
    expect(await complete({ token })).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses an expired token', async () => {
    await request('jdoe');
    const late = new Date(NOW.getTime() + 31 * 60 * 1000);
    expect(await complete({ now: late })).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a password the tenant policy rejects, without spending the token', async () => {
    await request('jdoe');
    expect(await complete({ newPassword: 'short' })).toEqual({
      ok: false,
      reason: 'weak_password',
      detail: 'too_short',
    });
    // Still usable: a rejected password is the user's typo, not an attack.
    expect(await complete()).toEqual({ ok: true });
  });

  it('revokes every session', async () => {
    const token = await withTenant(tenantId, (tx) => createSession(tx, userId, 'portal'));
    await request('jdoe');
    await complete();
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, token.token))).toBeNull();
  });

  it('revokes every refresh token', async () => {
    await withTenant(tenantId, (tx) =>
      tx.refreshToken.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'stand-in-for-an-access-ii-token',
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    );
    await request('jdoe');
    await complete();
    const rows = await withTenant(tenantId, (tx) => tx.refreshToken.findMany());
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it('writes an audit event', async () => {
    await request('jdoe');
    await complete();
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.password_reset_completed' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('success');
  });

  it('tells the user their password changed', async () => {
    await request('jdoe');
    await complete();
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.subject).toContain('password was changed');
  });

  it('does not fail the reset when the mail server is down', async () => {
    // The reset has committed by the time the confirmation is sent. A dead
    // SMTP server turning that into a thrown error would tell the user their
    // password change failed when it did not.
    await request('jdoe');
    const dead = {
      send: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:1025');
      },
    };
    const outcome = await completePasswordReset(tenantId, dead, {
      token: tokenFromMail()!,
      newPassword: NEW_PASSWORD,
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: true });

    await notificationsSettled();
    const failures = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'notify.delivery_failed' } }),
    );
    // Not silent either: the one control that reaches the account owner has
    // to leave a trace when it does not reach them.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.outcome).toBe('failure');
  });
});

describe('completePasswordReset with a second factor', () => {
  let codes: string[];

  beforeEach(async () => {
    codes = await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await request('jdoe');
  });

  it('refuses without the factor — otherwise reset is a way around MFA', async () => {
    const outcome = await completePasswordReset(tenantId, transport, {
      token: tokenFromMail()!,
      newPassword: NEW_PASSWORD,
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: 'factor_required' });

    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(await verifyPassword(credential.hash, PASSWORD)).toBe(true);
  });

  it('refuses a wrong factor without spending the token', async () => {
    const token = tokenFromMail()!;
    const bad = await completePasswordReset(tenantId, transport, {
      token,
      newPassword: NEW_PASSWORD,
      factor: { type: 'recovery_code', code: 'ZZZZZ-ZZZZZ' },
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(bad).toEqual({ ok: false, reason: 'factor_invalid' });

    const good = await completePasswordReset(tenantId, transport, {
      token,
      newPassword: NEW_PASSWORD,
      factor: { type: 'recovery_code', code: codes[0]! },
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(good).toEqual({ ok: true });
  });

  it('accepts a valid factor and spends it', async () => {
    const outcome = await completePasswordReset(tenantId, transport, {
      token: tokenFromMail()!,
      newPassword: NEW_PASSWORD,
      factor: { type: 'recovery_code', code: codes[0]! },
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: true });

    const spent = await withTenant(tenantId, (tx) =>
      tx.recoveryCode.count({ where: { userId, usedAt: { not: null } } }),
    );
    expect(spent).toBe(1);
  });
});
