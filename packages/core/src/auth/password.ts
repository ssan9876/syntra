import argon2 from 'argon2';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

/**
 * OWASP's minimum configuration for Argon2id. The parameters are embedded in
 * the encoded hash, so they can be raised later without invalidating existing
 * credentials — an old hash still verifies under the settings it was made with.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed stored hash is a verification failure, not a crash.
    return false;
  }
}

/**
 * Writes an already-computed hash, and the only way to set a password.
 *
 * The hashing itself is the caller's job, so it can happen outside a
 * transaction — Argon2id is deliberately expensive and has no business inside
 * Prisma's 5000 ms budget. There used to be a `setPassword(tx, userId, plain)`
 * beside this that did both, and it is gone rather than documented: one entry
 * point that cannot do the wrong thing beats two that explain which is which.
 * Nothing in the running product called it; the seed and the tests did, which
 * is exactly how the shape survives long enough to be copied.
 */
export async function setPasswordHash(
  tx: TenantClient,
  userId: string,
  hash: string,
): Promise<void> {
  const tenantId = await currentTenant(tx);
  await tx.passwordCredential.upsert({
    where: { userId },
    create: { tenantId, userId, hash },
    update: { hash },
  });
}

export async function hasPassword(
  tx: TenantClient,
  userId: string,
): Promise<boolean> {
  const credential = await tx.passwordCredential.findUnique({
    where: { userId },
  });
  return credential !== null;
}
