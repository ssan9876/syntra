import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from './master-key.js';

/**
 * Seals a value under a fresh data key, then seals that key under the master
 * key. A per-secret data key means two secrets holding the same value produce
 * different ciphertext, and rotating the master key rewraps keys rather than
 * re-encrypting every value.
 */
export async function putSecret(
  tx: TenantClient,
  provider: MasterKeyProvider,
  name: string,
  plaintext: string,
): Promise<{ id: string; name: string }> {
  const tenantId = await currentTenant(tx);

  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const wrapped = await provider.wrap(dek);
  dek.fill(0);

  return tx.secret.upsert({
    where: { tenantId_name: { tenantId, name } },
    create: {
      tenantId,
      name,
      ciphertext,
      iv,
      tag,
      wrappedDek: wrapped.ciphertext,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
    },
    update: {
      ciphertext,
      iv,
      tag,
      wrappedDek: wrapped.ciphertext,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
    },
    select: { id: true, name: true },
  });
}

/**
 * Internal only. No route returns this value to a client: a secret, once
 * written, may be replaced but never read back out of the system.
 */
export async function getSecret(
  tx: TenantClient,
  provider: MasterKeyProvider,
  name: string,
): Promise<string | null> {
  const row = await tx.secret.findFirst({ where: { name } });
  if (!row) return null;

  const dek = await provider.unwrap({
    ciphertext: row.wrappedDek,
    iv: row.dekIv,
    tag: row.dekTag,
  });

  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, row.iv);
    decipher.setAuthTag(row.tag);
    return Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** Safe to expose: names and timestamps only, never ciphertext or keys. */
export async function listSecretNames(tx: TenantClient) {
  return tx.secret.findMany({
    select: { id: true, name: true, updatedAt: true },
    orderBy: { name: 'asc' },
  });
}

export async function deleteSecret(
  tx: TenantClient,
  name: string,
): Promise<void> {
  await tx.secret.deleteMany({ where: { name } });
}
