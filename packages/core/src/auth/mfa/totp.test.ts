import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import { localMasterKeyProvider } from '../../vault/master-key.js';
import { getSecret } from '../../vault/vault-service.js';
import {
  TOTP_PERIOD_SECONDS,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  hasTotp,
  removeTotp,
  totpVerifier,
} from './totp.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

let tenantId: string;
let userId: string;

const NOW = new Date('2026-08-12T09:00:00Z');

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

const enrol = () =>
  withTenant(tenantId, (tx) => beginTotpEnrolment(tx, provider, userId));

const codeAt = (secret: string, at: Date) =>
  OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    period: TOTP_PERIOD_SECONDS,
    digits: 6,
    algorithm: 'SHA1',
    timestamp: at.getTime(),
  });

/** TOTP never reads it, but the context shape is the same for every factor. */
const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };

const verify = (code: string, at = NOW) =>
  totpVerifier(provider).verify(tenantId, userId, { type: 'totp', code }, {
    now: at,
    relyingParty: RP,
  });

describe('beginTotpEnrolment', () => {
  it('returns a base32 secret and an otpauth URI', async () => {
    const enrolment = await enrol();
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrolment.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(enrolment.uri).toContain(`secret=${enrolment.secret}`);
  });

  it('stores the secret in the vault, not on the row', async () => {
    const enrolment = await enrol();
    const row = await withTenant(tenantId, (tx) =>
      tx.totpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(JSON.stringify(row)).not.toContain(enrolment.secret);

    const stored = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, row.secretName),
    );
    expect(stored).toBe(enrolment.secret);
  });

  it('leaves the credential unconfirmed until a code is presented', async () => {
    await enrol();
    const row = await withTenant(tenantId, (tx) =>
      tx.totpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(row.confirmedAt).toBeNull();
    expect(await withTenant(tenantId, (tx) => hasTotp(tx, userId))).toBe(false);
  });

  it('replaces an unconfirmed enrolment rather than failing', async () => {
    const first = await enrol();
    const second = await enrol();
    expect(second.secret).not.toBe(first.secret);
    expect(await withTenant(tenantId, (tx) => tx.totpCredential.count())).toBe(1);
  });
});

describe('confirmTotpEnrolment', () => {
  it('accepts a current code and marks the credential confirmed', async () => {
    const enrolment = await enrol();
    const ok = await confirmTotpEnrolment(
      tenantId,
      provider,
      userId,
      codeAt(enrolment.secret, NOW),
      NOW,
    );
    expect(ok).toBe(true);
    expect(await withTenant(tenantId, (tx) => hasTotp(tx, userId))).toBe(true);
  });

  it('refuses a wrong code and leaves the credential unconfirmed', async () => {
    await enrol();
    expect(await confirmTotpEnrolment(tenantId, provider, userId, '000000', NOW)).toBe(false);
    expect(await withTenant(tenantId, (tx) => hasTotp(tx, userId))).toBe(false);
  });
});

describe('totpVerifier', () => {
  let secret: string;

  beforeEach(async () => {
    const enrolment = await enrol();
    secret = enrolment.secret;
    await confirmTotpEnrolment(tenantId, provider, userId, codeAt(secret, NOW), NOW);
  });

  it('accepts a code from the current step', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    expect(await verify(codeAt(secret, later), later)).toEqual({ ok: true });
  });

  it('accepts a code from one step back, for a slow phone', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const oneStepBack = new Date(later.getTime() - TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, oneStepBack), later)).toEqual({ ok: true });
  });

  it('accepts a code from one step forward, for a fast phone', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const oneStepOn = new Date(later.getTime() + TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, oneStepOn), later)).toEqual({ ok: true });
  });

  it('refuses a code two steps away', async () => {
    const later = new Date(NOW.getTime() + 300_000);
    const tooOld = new Date(later.getTime() - 2 * TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, tooOld), later)).toEqual({
      ok: false,
      reason: 'totp_invalid',
    });
  });

  it('refuses the same code twice', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const code = codeAt(secret, later);
    expect(await verify(code, later)).toEqual({ ok: true });
    expect(await verify(code, later)).toEqual({ ok: false, reason: 'totp_replayed' });
  });

  it('refuses a code from a step already used, even a valid earlier one', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    await verify(codeAt(secret, later), later);
    const oneStepBack = new Date(later.getTime() - TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, oneStepBack), later)).toEqual({
      ok: false,
      reason: 'totp_replayed',
    });
  });

  it('names the enrolment code specifically when it is presented again', async () => {
    // Enrol, then try to sign in with the same code seconds later. The refusal
    // is correct; an unexplained one is a support ticket, so it carries its own
    // reason all the way out to a sentence on the screen.
    await withTenant(tenantId, (tx) => removeTotp(tx, userId));
    const fresh = await enrol();
    const code = codeAt(fresh.secret, NOW);
    expect(await confirmTotpEnrolment(tenantId, provider, userId, code, NOW)).toBe(true);

    expect(await verify(code, NOW)).toEqual({
      ok: false,
      reason: 'totp_used_for_enrolment',
    });
  });

  it('still reports an ordinary replay as a replay', async () => {
    const later = new Date(NOW.getTime() + 120_000);
    const code = codeAt(secret, later);
    expect(await verify(code, later)).toEqual({ ok: true });
    // Not the enrolment step, so not the enrolment message.
    expect(await verify(code, later)).toEqual({ ok: false, reason: 'totp_replayed' });
  });

  it('accepts the next step after one has been used', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    await verify(codeAt(secret, later), later);
    const next = new Date(later.getTime() + TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, next), next)).toEqual({ ok: true });
  });

  it('refuses a user with no TOTP credential', async () => {
    await withTenant(tenantId, (tx) => removeTotp(tx, userId));
    expect(await verify('000000')).toEqual({ ok: false, reason: 'totp_not_enrolled' });
  });

  it('refuses an unconfirmed credential', async () => {
    await withTenant(tenantId, (tx) => removeTotp(tx, userId));
    const fresh = await enrol();
    const later = new Date(NOW.getTime() + 60_000);
    expect(await verify(codeAt(fresh.secret, later), later)).toEqual({
      ok: false,
      reason: 'totp_not_enrolled',
    });
  });

  it('refuses a code of the wrong shape without touching the vault', async () => {
    expect(await verify('12345')).toEqual({ ok: false, reason: 'totp_invalid' });
    expect(await verify('abcdef')).toEqual({ ok: false, reason: 'totp_invalid' });
    expect(await verify('')).toEqual({ ok: false, reason: 'totp_invalid' });
  });
});

describe('removeTotp', () => {
  it('removes the credential and the vault secret together', async () => {
    const enrolment = await enrol();
    await confirmTotpEnrolment(tenantId, provider, userId, codeAt(enrolment.secret, NOW), NOW);
    const row = await withTenant(tenantId, (tx) =>
      tx.totpCredential.findUniqueOrThrow({ where: { userId } }),
    );

    await withTenant(tenantId, (tx) => removeTotp(tx, userId));

    expect(await withTenant(tenantId, (tx) => tx.totpCredential.count())).toBe(0);
    expect(await withTenant(tenantId, (tx) => getSecret(tx, provider, row.secretName))).toBeNull();
  });
});
