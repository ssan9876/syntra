import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import { renderMessage, sendMessage, type Transport } from '../../notify/notification-service.js';
import { registerFactorVerifier } from './registry.js';
import type { FactorVerifier, FactorVerifyResult } from './types.js';

/**
 * A one-time code mailed to the address on the account.
 *
 * **Weaker than the other two, and the product says so.** Wherever the same
 * mailbox can also reset the password, this adds nothing an attacker holding
 * that mailbox does not already have — which is why `Tenant.emailOtpEnabled`
 * is off by default and why `enrollable` consults it. It exists because "no
 * phone and no security key" is a real situation, and a person in it currently
 * has no second factor at all.
 */

export const EMAIL_OTP_DIGITS = 6;
/**
 * Ten minutes. Long enough for a mail server having a slow morning, short
 * enough that a code read over somebody's shoulder is worthless by lunchtime.
 */
export const EMAIL_OTP_TTL_MS = 10 * 60_000;
/**
 * Wrong guesses before the code is dead and a new one must be requested.
 *
 * Six digits is about twenty bits, so the code is only as strong as the number
 * of tries allowed against it. Five leaves a one-in-two-hundred-thousand
 * chance per code, and a fresh code costs the attacker another mail they
 * cannot read.
 */
export const EMAIL_OTP_MAX_ATTEMPTS = 5;
/** A resend before this is refused, so the button is not a mail cannon. */
export const EMAIL_OTP_RESEND_MS = 60_000;

const hash = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * A code from `randomInt`, not `Math.random`.
 *
 * Uniform over the whole six-digit range including leading zeros: generating
 * `100000 + random(900000)` — the obvious way to avoid padding — throws away
 * a tenth of the space for the sake of not calling `padStart`.
 */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(EMAIL_OTP_DIGITS, '0');
}

const CODE_SHAPE = /^[0-9]{6}$/;

export type SendOutcome =
  | { sent: true }
  | { sent: false; reason: 'too_soon' | 'no_address' | 'not_enabled' };

export async function emailOtpEnabledFor(tx: TenantClient): Promise<boolean> {
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  return tenant.emailOtpEnabled;
}

/**
 * Mints a code, stores its hash, and returns the code for the caller to mail.
 *
 * Returns the code rather than sending it, because sending is a network call
 * and this runs in a transaction. `sendEmailOtp` below is the pair that does
 * both in the right order.
 *
 * Resetting `attempts` here is the point of minting: a new code is a new
 * budget. Without it a person who mistyped five times could never recover, and
 * with an unreset budget a resend would hand an attacker five more guesses at
 * the same secret.
 */
export async function mintEmailOtp(
  tx: TenantClient,
  userId: string,
  now: Date,
): Promise<{ code: string } | { refused: 'too_soon' }> {
  const tenantId = await currentTenant(tx);
  const existing = await tx.emailOtpCredential.findUnique({ where: { userId } });

  if (existing?.sentAt && now.getTime() - existing.sentAt.getTime() < EMAIL_OTP_RESEND_MS) {
    return { refused: 'too_soon' };
  }

  const code = newCode();
  const data = {
    codeHash: hash(code),
    expiresAt: new Date(now.getTime() + EMAIL_OTP_TTL_MS),
    attempts: 0,
    sentAt: now,
  };

  await tx.emailOtpCredential.upsert({
    where: { userId },
    create: { tenantId, userId, ...data },
    update: data,
  });

  return { code };
}

/**
 * Mints a code and mails it.
 *
 * Three phases and the middle one holds no transaction, the same shape every
 * other sending path here uses: read and write in one short transaction, send
 * outside it. An SMTP round trip inside `prisma.$transaction` has shipped as a
 * defect on this project twice.
 */
export async function sendEmailOtp(
  tenantId: string,
  transport: Transport,
  userId: string,
  now: Date = new Date(),
): Promise<SendOutcome> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!tenant.emailOtpEnabled) return { refused: 'not_enabled' as const };

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true },
    });
    if (!user?.email) return { refused: 'no_address' as const };

    const minted = await mintEmailOtp(tx, userId, now);
    if ('refused' in minted) return { refused: 'too_soon' as const };

    return { code: minted.code, email: user.email, displayName: user.displayName, tenantName: tenant.name };
  });

  if ('refused' in prepared) return { sent: false, reason: prepared.refused };

  await sendMessage(
    transport,
    renderMessage(prepared.tenantName, 'email-otp', prepared.email, {
      displayName: prepared.displayName,
      code: prepared.code,
      minutes: String(Math.round(EMAIL_OTP_TTL_MS / 60_000)),
    }),
  );
  return { sent: true };
}

/**
 * Checks a code and consumes it.
 *
 * The code is cleared on SUCCESS and on exhaustion, never left behind: a
 * one-time code that survives its use is not one. On an ordinary wrong guess
 * the code stays and `attempts` rises, so a typo does not cost a fresh mail.
 */
export async function verifyEmailOtp(
  tx: TenantClient,
  userId: string,
  code: string,
  now: Date,
): Promise<FactorVerifyResult> {
  // Shape-checked before anything is read, so a malformed submission costs no
  // query and cannot consume an attempt.
  if (!CODE_SHAPE.test(code)) return { ok: false, reason: 'invalid_code' };

  const row = await tx.emailOtpCredential.findUnique({ where: { userId } });
  if (!row?.codeHash || !row.expiresAt) return { ok: false, reason: 'no_code' };
  if (row.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (row.attempts >= EMAIL_OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  const expected = Buffer.from(row.codeHash, 'utf8');
  const given = Buffer.from(hash(code), 'utf8');
  const matches = expected.length === given.length && timingSafeEqual(expected, given);

  if (!matches) {
    const attempts = row.attempts + 1;
    await tx.emailOtpCredential.update({
      where: { userId },
      data:
        attempts >= EMAIL_OTP_MAX_ATTEMPTS
          ? // Spent. The code is destroyed rather than left sitting at its
            // limit, so a stolen database row carries nothing to grind.
            { attempts, codeHash: null, expiresAt: null }
          : { attempts },
    });
    return { ok: false, reason: 'invalid_code' };
  }

  await tx.emailOtpCredential.update({
    where: { userId },
    data: {
      codeHash: null,
      expiresAt: null,
      attempts: 0,
      // Verifying a code IS the enrolment. There is no separate confirm step,
      // because there is no separate secret to confirm — the credential is
      // "this person can read that mailbox", which they just demonstrated.
      confirmedAt: row.confirmedAt ?? now,
    },
  });
  return { ok: true };
}

export async function emailOtpEnrolled(
  tx: TenantClient,
  userId: string,
): Promise<boolean> {
  const row = await tx.emailOtpCredential.findUnique({
    where: { userId },
    select: { confirmedAt: true },
  });
  return row?.confirmedAt != null;
}

/**
 * Removes the factor.
 *
 * Nothing to unseal and nothing to revoke elsewhere — the mailbox is not this
 * product's to take away.
 */
export async function removeEmailOtp(tx: TenantClient, userId: string): Promise<void> {
  await tx.emailOtpCredential.deleteMany({ where: { userId } });
}

/**
 * Registers the verifier.
 *
 * `enrollable` is FIXED TRUE here and gated per tenant at the point of offer,
 * not here: `enrollableFactorTypes()` is a property of the process — what this
 * deployment can do at all — and has no tenant to consult. The tenant check
 * lives where a tenant is in scope; see `emailOtpEnabledFor`.
 */
export function installEmailOtpVerifier(): void {
  const verifier: FactorVerifier = {
    type: 'email_otp',
    enrollable: true,
    enrolled: emailOtpEnrolled,
    async verify(tenantId, userId, presentation, context) {
      if (presentation.type !== 'email_otp') {
        return { ok: false, reason: 'factor_not_available' };
      }
      return withTenant(tenantId, (tx) =>
        verifyEmailOtp(tx, userId, presentation.code, context.now),
      );
    },
  };
  registerFactorVerifier(verifier);
}
