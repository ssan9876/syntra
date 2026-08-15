import { createHash, randomInt } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import { registerFactorVerifier } from './registry.js';
import type { FactorVerifier, FactorVerifyResult } from './types.js';

export const RECOVERY_CODE_COUNT = 10;

/** Crockford-style: no I, L, O, U, 0 or 1, so a handwritten code reads back. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP = 5;

/**
 * SHA-256, not Argon2id.
 *
 * A recovery code is fifty bits of uniformly random data from a
 * cryptographically secure source, so there is no dictionary to run against it
 * and no password-reuse risk to blunt; the slow hash buys nothing and would
 * cost ten Argon2 verifications per attempt. A password is the opposite case,
 * which is why password.ts uses Argon2id.
 */
const hashCode = (normalised: string) =>
  createHash('sha256').update(normalised).digest('hex');

/** Uppercase, separators and spaces stripped: what the user typed is not the point. */
const normalise = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

function makeCode(): string {
  let out = '';
  for (let i = 0; i < GROUP * 2; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${out.slice(0, GROUP)}-${out.slice(GROUP)}`;
}

/**
 * Issues a fresh set and discards the previous one. Returned in the clear
 * exactly once — the database holds only digests, so a lost sheet of codes is
 * regenerated, never recovered.
 */
export async function generateRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<string[]> {
  const tenantId = await currentTenant(tx);
  await tx.recoveryCode.deleteMany({ where: { userId } });

  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < RECOVERY_CODE_COUNT) {
    const code = makeCode();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  await tx.recoveryCode.createMany({
    data: codes.map((code) => ({
      tenantId,
      userId,
      codeHash: hashCode(normalise(code)),
    })),
  });

  return codes;
}

export async function countUnusedRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<number> {
  return tx.recoveryCode.count({ where: { userId, usedAt: null } });
}

export async function hasRecoveryCodesFor(
  tx: TenantClient,
  userId: string,
): Promise<boolean> {
  return (await countUnusedRecoveryCodes(tx, userId)) > 0;
}

export async function removeRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<void> {
  await tx.recoveryCode.deleteMany({ where: { userId } });
}

/**
 * Consumption is one conditional UPDATE whose row count is checked. Reading the
 * row and then writing it would let two requests presenting the same code both
 * find it unused; this way the second one updates zero rows and is refused,
 * because PostgreSQL serialises the two updates on the row lock and the second
 * re-evaluates `usedAt IS NULL` after the first commits.
 */
export function recoveryCodeVerifier(): FactorVerifier {
  return {
    type: 'recovery_code',
    // Deliberately not enrollable. A recovery code is the fallback you generate
    // once you already hold a real factor; offering it as the way to satisfy a
    // require_mfa rule would let a user answer "prove you have a second factor"
    // by printing themselves one.
    enrollable: false,

    async enrolled(tx, userId) {
      return hasRecoveryCodesFor(tx, userId);
    },

    async verify(tenantId, userId, presentation, context): Promise<FactorVerifyResult> {
      const { now } = context;
      if (presentation.type !== 'recovery_code') {
        return { ok: false, reason: 'recovery_code_invalid' };
      }
      const codeHash = hashCode(normalise(presentation.code));

      return withTenant(tenantId, async (tx) => {
        const claimed = await tx.recoveryCode.updateMany({
          where: { userId, codeHash, usedAt: null },
          data: { usedAt: now },
        });
        if (claimed.count === 1) return { ok: true };

        // Distinguish "wrong code" from "already spent" for the audit log only.
        // Both answer the user identically, one level up.
        const exists = await tx.recoveryCode.count({ where: { userId, codeHash } });
        return {
          ok: false,
          reason: exists > 0 ? 'recovery_code_used' : 'recovery_code_invalid',
        };
      });
    },
  };
}

export function installRecoveryCodeVerifier(): void {
  registerFactorVerifier(recoveryCodeVerifier());
}
