import { timingSafeEqual } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import type { MasterKeyProvider } from '../../vault/master-key.js';
import { deleteSecret, getSecret, putSecret } from '../../vault/vault-service.js';
import { registerFactorVerifier } from './registry.js';
import type { FactorVerifier, FactorVerifyResult } from './types.js';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ALGORITHM = 'SHA1';

/**
 * One step either side of now. RFC 6238 calls a small window acceptable for
 * clock drift; every extra step is another code an attacker who shoulder-surfed
 * one gets to use, so this is deliberately the smallest useful value.
 */
export const TOTP_WINDOW_STEPS = 1;

const CODE_SHAPE = /^[0-9]{6}$/;

const secretNameFor = (userId: string) => `totp.${userId}`;

export interface TotpEnrolment {
  secret: string;
  uri: string;
}

/**
 * Starts enrolment: a fresh secret into the vault, an unconfirmed credential
 * row, and the shared secret returned to the caller exactly once. The
 * credential does not count as a factor until the user proves possession.
 */
export async function beginTotpEnrolment(
  tx: TenantClient,
  provider: MasterKeyProvider,
  userId: string,
): Promise<TotpEnrolment> {
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

  const existing = await tx.totpCredential.findUnique({ where: { userId } });
  if (existing?.confirmedAt) {
    throw new Error('a confirmed TOTP credential already exists for this user');
  }

  const secret = new OTPAuth.Secret({ size: 20 });
  const base32 = secret.base32;
  const secretName = secretNameFor(userId);

  await putSecret(tx, provider, secretName, base32);

  await tx.totpCredential.upsert({
    where: { userId },
    create: {
      tenantId,
      userId,
      secretName,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    },
    update: { secretName, lastCounter: null, confirmedAt: null },
  });

  const uri = new OTPAuth.TOTP({
    issuer: tenant.name,
    label: user.login,
    secret,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  }).toString();

  return { secret: base32, uri };
}

interface StepMatch {
  counter: number;
}

/**
 * Finds which counter step, if any, the presented code belongs to.
 *
 * Every candidate is compared with timingSafeEqual and the loop runs to the
 * end rather than returning early, so the time taken does not disclose which
 * step matched or whether any did. Comparing with === would leak the shared
 * prefix one byte at a time.
 */
function matchStep(
  secret: OTPAuth.Secret,
  code: string,
  period: number,
  digits: number,
  algorithm: string,
  now: Date,
): StepMatch | null {
  const presented = Buffer.from(code, 'utf8');
  const current = OTPAuth.TOTP.counter({ period, timestamp: now.getTime() });

  let found: StepMatch | null = null;
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
    const timestamp = (current + delta) * period * 1000;
    const expected = Buffer.from(
      OTPAuth.TOTP.generate({ secret, period, digits, algorithm, timestamp }),
      'utf8',
    );
    if (
      expected.length === presented.length &&
      timingSafeEqual(expected, presented) &&
      found === null
    ) {
      found = { counter: current + delta };
    }
  }
  return found;
}

/**
 * Confirms an enrolment. Takes a tenantId rather than a transaction: unwrapping
 * the vault key and generating three candidate codes is work that does not
 * belong inside a caller's interactive transaction.
 */
export async function confirmTotpEnrolment(
  tenantId: string,
  provider: MasterKeyProvider,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!CODE_SHAPE.test(code)) return false;

  const row = await withTenant(tenantId, (tx) =>
    tx.totpCredential.findUnique({ where: { userId } }),
  );
  if (!row || row.confirmedAt) return false;

  const base32 = await withTenant(tenantId, (tx) =>
    getSecret(tx, provider, row.secretName),
  );
  if (!base32) return false;

  const match = matchStep(
    OTPAuth.Secret.fromBase32(base32),
    code,
    row.period,
    row.digits,
    row.algorithm,
    now,
  );
  if (!match) return false;

  await withTenant(tenantId, (tx) =>
    tx.totpCredential.update({
      where: { userId },
      data: { confirmedAt: now, lastCounter: match.counter },
    }),
  );
  return true;
}

export async function hasTotp(tx: TenantClient, userId: string): Promise<boolean> {
  const row = await tx.totpCredential.findUnique({ where: { userId } });
  return row !== null && row.confirmedAt !== null;
}

export async function removeTotp(tx: TenantClient, userId: string): Promise<void> {
  const row = await tx.totpCredential.findUnique({ where: { userId } });
  if (!row) return;
  await tx.totpCredential.delete({ where: { userId } });
  await deleteSecret(tx, row.secretName);
}

/**
 * The verifier the chokepoint consults.
 *
 * Acceptance is not just "the arithmetic works": the step that produced the
 * code must be strictly later than the last step already accepted, and the
 * watermark is advanced with a conditional update whose row count is checked.
 * Without both, a code shoulder-surfed inside its 30-second window is usable a
 * second time, and two requests presenting it at once both succeed.
 */
export function totpVerifier(provider: MasterKeyProvider): FactorVerifier {
  return {
    type: 'totp',
    // A user with no factor may add this one mid-sign-in when policy demands
    // it: an authenticator app needs nothing an administrator has to post out.
    enrollable: true,

    async enrolled(tx, userId) {
      return hasTotp(tx, userId);
    },

    async verify(tenantId, userId, presentation, context): Promise<FactorVerifyResult> {
      const { now } = context;
      if (presentation.type !== 'totp') {
        return { ok: false, reason: 'totp_invalid' };
      }
      if (!CODE_SHAPE.test(presentation.code)) {
        return { ok: false, reason: 'totp_invalid' };
      }

      const row = await withTenant(tenantId, (tx) =>
        tx.totpCredential.findUnique({ where: { userId } }),
      );
      if (!row || !row.confirmedAt) {
        return { ok: false, reason: 'totp_not_enrolled' };
      }

      const base32 = await withTenant(tenantId, (tx) =>
        getSecret(tx, provider, row.secretName),
      );
      if (!base32) {
        // The row says enrolled and the vault disagrees. That is a fault, not
        // a wrong code, and it is recorded as its own reason rather than
        // disappearing into "invalid".
        return { ok: false, reason: 'totp_secret_missing' };
      }

      const match = matchStep(
        OTPAuth.Secret.fromBase32(base32),
        presentation.code,
        row.period,
        row.digits,
        row.algorithm,
        now,
      );
      if (!match) return { ok: false, reason: 'totp_invalid' };

      if (row.lastCounter !== null && match.counter <= row.lastCounter) {
        // The watermark is set at confirmation, so the very code that
        // completed enrolment is refused if it is presented again inside its
        // own thirty-second step. That is the point — it stops the enrolment
        // code being replayed as a login — but it is also the one refusal a
        // user is guaranteed to meet while looking at a correct code, so it
        // gets its own reason rather than disappearing into "invalid".
        const enrolCounter = row.confirmedAt
          ? OTPAuth.TOTP.counter({
              period: row.period,
              timestamp: row.confirmedAt.getTime(),
            })
          : null;
        if (enrolCounter !== null && match.counter === enrolCounter) {
          return { ok: false, reason: 'totp_used_for_enrolment' };
        }
        return { ok: false, reason: 'totp_replayed' };
      }

      const advanced = await withTenant(tenantId, (tx) =>
        tx.totpCredential.updateMany({
          where: {
            userId,
            OR: [{ lastCounter: null }, { lastCounter: { lt: match.counter } }],
          },
          data: { lastCounter: match.counter },
        }),
      );
      // Zero rows means another request advanced the watermark first. That
      // request has the code; this one is a replay of it.
      if (advanced.count !== 1) return { ok: false, reason: 'totp_replayed' };

      return { ok: true };
    },
  };
}

export function installTotpVerifier(provider: MasterKeyProvider): void {
  registerFactorVerifier(totpVerifier(provider));
}
