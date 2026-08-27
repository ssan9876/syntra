import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import { memoryTransport } from '../../notify/notification-service.js';
import {
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_RESEND_MS,
  EMAIL_OTP_TTL_MS,
  emailOtpEnrolled,
  mintEmailOtp,
  removeEmailOtp,
  sendEmailOtp,
  verifyEmailOtp,
} from './email-otp.js';

let tenantId: string;
let userId: string;
const NOW = new Date('2026-08-26T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

async function enableEmailOtp() {
  await prisma.tenant.update({ where: { id: tenantId }, data: { emailOtpEnabled: true } });
}

const mint = (now = NOW) => withTenant(tenantId, (tx) => mintEmailOtp(tx, userId, now));
const verify = (code: string, now = NOW) =>
  withTenant(tenantId, (tx) => verifyEmailOtp(tx, userId, code, now));

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  const user = await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'ada', email: 'ada@acme.test', displayName: 'Ada' }),
  );
  userId = user.id;
});

describe('verifyEmailOtp', () => {
  it('accepts the code that was minted, and enrols on the way', async () => {
    // Verifying a code IS the enrolment: there is no separate secret to
    // confirm, because the credential is "this person can read that mailbox".
    const minted = await mint();
    expect(await verify((minted as { code: string }).code)).toEqual({ ok: true });
    expect(await withTenant(tenantId, (tx) => emailOtpEnrolled(tx, userId))).toBe(true);
  });

  it('consumes the code, so it works once', async () => {
    const minted = await mint();
    const code = (minted as { code: string }).code;
    expect(await verify(code)).toEqual({ ok: true });
    // A one-time code that survives its use is not one.
    expect(await verify(code)).toMatchObject({ ok: false, reason: 'no_code' });
  });

  it('refuses a code past its life', async () => {
    const minted = await mint();
    const result = await verify((minted as { code: string }).code, later(EMAIL_OTP_TTL_MS + 1));
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses a malformed submission without spending an attempt', async () => {
    // Shape-checked before anything is read, so a typo in the box costs no
    // query and no budget.
    await mint();
    expect(await verify('abc')).toMatchObject({ ok: false, reason: 'invalid_code' });
    const row = await withTenant(tenantId, (tx) =>
      tx.emailOtpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(row.attempts).toBe(0);
  });

  it('destroys the code once the attempts are spent', async () => {
    const minted = await mint();
    const real = (minted as { code: string }).code;
    const wrong = real === '000000' ? '111111' : '000000';

    for (let i = 0; i < EMAIL_OTP_MAX_ATTEMPTS; i += 1) {
      expect(await verify(wrong)).toMatchObject({ ok: false });
    }

    // Six digits is twenty bits; the code is only as strong as the number of
    // tries allowed against it. And it is destroyed rather than left sitting
    // at its limit, so a stolen row carries nothing to grind.
    const row = await withTenant(tenantId, (tx) =>
      tx.emailOtpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(row.codeHash).toBeNull();
    expect(await verify(real)).toMatchObject({ ok: false, reason: 'no_code' });
  });

  it('never stores the code itself', async () => {
    const minted = await mint();
    const code = (minted as { code: string }).code;
    const row = await withTenant(tenantId, (tx) =>
      tx.emailOtpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(JSON.stringify(row)).not.toContain(code);
  });
});

describe('minting', () => {
  it('refuses a resend inside the window', async () => {
    // The button is not a mail cannon.
    await mint();
    expect(await mint(later(EMAIL_OTP_RESEND_MS - 1))).toEqual({ refused: 'too_soon' });
  });

  it('allows one after the window, and resets the budget', async () => {
    // A new code is a new budget: without the reset somebody who mistyped five
    // times could never recover. Without minting a NEW code, a resend would
    // hand an attacker five more guesses at the same secret.
    const first = await mint();
    const wrong = (first as { code: string }).code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i += 1) await verify(wrong);

    const again = await mint(later(EMAIL_OTP_RESEND_MS + 1));
    expect(again).toHaveProperty('code');
    expect((again as { code: string }).code).not.toBe((first as { code: string }).code);

    const row = await withTenant(tenantId, (tx) =>
      tx.emailOtpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(row.attempts).toBe(0);
  });
});

describe('sendEmailOtp', () => {
  it('refuses when the tenant has not enabled it', async () => {
    // Off by default: a code mailed to the address on the account adds nothing
    // wherever that mailbox can also reset the password.
    const transport = memoryTransport();
    expect(await sendEmailOtp(tenantId, transport, userId, NOW)).toEqual({
      sent: false,
      reason: 'not_enabled',
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('mails the code once the tenant has enabled it', async () => {
    await enableEmailOtp();
    const transport = memoryTransport();
    expect(await sendEmailOtp(tenantId, transport, userId, NOW)).toEqual({ sent: true });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('ada@acme.test');
    // The code reaches the person and nothing else does: no application name,
    // no source address. This mail may arrive for somebody who did not ask.
    expect(transport.sent[0]!.text).toMatch(/\b\d{6}\b/);
  });

  it('does not mail a second code inside the resend window', async () => {
    await enableEmailOtp();
    const transport = memoryTransport();
    await sendEmailOtp(tenantId, transport, userId, NOW);
    expect(await sendEmailOtp(tenantId, transport, userId, NOW)).toEqual({
      sent: false,
      reason: 'too_soon',
    });
    expect(transport.sent).toHaveLength(1);
  });
});

describe('removeEmailOtp', () => {
  it('takes the factor away', async () => {
    await mint();
    const row = await withTenant(tenantId, (tx) =>
      tx.emailOtpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    await verify('000000').catch(() => undefined);
    void row;

    await withTenant(tenantId, (tx) => removeEmailOtp(tx, userId));
    expect(await withTenant(tenantId, (tx) => emailOtpEnrolled(tx, userId))).toBe(false);
  });
});
