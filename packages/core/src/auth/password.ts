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

export async function setPassword(
  tx: TenantClient,
  userId: string,
  plain: string,
): Promise<void> {
  const tenantId = await currentTenant(tx);
  const hash = await hashPassword(plain);
  await tx.passwordCredential.upsert({
    where: { userId },
    create: { tenantId, userId, hash },
    update: { hash },
  });
}

/**
 * Writes an already-computed hash. The hashing itself is the caller's job, so
 * it can happen outside a transaction — Argon2id is deliberately expensive and
 * has no business inside Prisma's 5000 ms transaction budget.
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
