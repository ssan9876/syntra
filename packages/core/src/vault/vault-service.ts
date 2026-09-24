import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { describeWrappedKey, type MasterKeyProvider, type WrappedKey } from './master-key.js';

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

  // A provider that can mint a data key (AWS GenerateDataKey) does, in the
  // same single round trip `wrap` would cost; the rest get a local random key
  // and wrap it. Either way the key is bound to this tenant: an external
  // provider uses that as AAD / encryption context, the local one ignores it.
  const context = { tenantId };
  let dek: Buffer;
  let wrapped: WrappedKey;
  if (provider.generate) {
    ({ dek, wrapped } = await provider.generate(context));
  } else {
    dek = randomBytes(32);
    try {
      wrapped = await provider.wrap(dek, context);
    } catch (cause) {
      dek.fill(0);
      throw cause;
    }
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  dek.fill(0);

  // Prisma types Bytes as Uint8Array<ArrayBuffer>; Node's Buffer is backed by
  // ArrayBufferLike, so copy into a plain view rather than casting.
  const bytes = (b: Buffer) => new Uint8Array(b);

  return tx.secret.upsert({
    where: { tenantId_name: { tenantId, name } },
    create: {
      tenantId,
      name,
      ciphertext: bytes(ciphertext),
      iv: bytes(iv),
      tag: bytes(tag),
      wrappedDek: bytes(wrapped.ciphertext),
      dekIv: bytes(wrapped.iv),
      dekTag: bytes(wrapped.tag),
    },
    update: {
      ciphertext: bytes(ciphertext),
      iv: bytes(iv),
      tag: bytes(tag),
      wrappedDek: bytes(wrapped.ciphertext),
      dekIv: bytes(wrapped.iv),
      dekTag: bytes(wrapped.tag),
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

  const dek = await provider.unwrap(
    {
      ciphertext: Buffer.from(row.wrappedDek),
      iv: Buffer.from(row.dekIv),
      tag: Buffer.from(row.dekTag),
    },
    { tenantId: row.tenantId },
  );

  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(row.iv));
    decipher.setAuthTag(Buffer.from(row.tag));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext)),
      decipher.final(),
    ]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}


export async function deleteSecret(
  tx: TenantClient,
  name: string,
): Promise<void> {
  await tx.secret.deleteMany({ where: { name } });
}

/**
 * Re-wrap data keys without decrypting the secret ciphertext. Call this while
 * the old master key is still available, verify with `next`, then switch the
 * deployment's configured key. A failure leaves the surrounding transaction
 * to roll back rather than leaving a mixed key set.
 *
 * `current` may be -- and in `rekey` is -- the deployment's composite
 * provider, which reads every format it has a key for. That is what makes a
 * rekey that died half way SAFE TO RUN AGAIN: rows it already moved are read
 * by the new provider and rewrapped under it once more, which changes nothing
 * but the ciphertext. It is also what moves Transit rows to the latest key
 * version when `current` and `next` are the same Vault key.
 *
 * Each data key is bound to the tenant the transaction is bound to, so a KMS
 * provider's encryption context follows the row.
 */
export async function rewrapSecrets(
  tx: TenantClient,
  current: MasterKeyProvider,
  next: MasterKeyProvider,
): Promise<{ rewrapped: number }> {
  const tenantId = await currentTenant(tx);
  const context = { tenantId };
  const rows = await tx.secret.findMany({ select: { id: true, wrappedDek: true, dekIv: true, dekTag: true } });
  for (const row of rows) {
    const dek = await current.unwrap(
      {
        ciphertext: Buffer.from(row.wrappedDek),
        iv: Buffer.from(row.dekIv),
        tag: Buffer.from(row.dekTag),
      },
      context,
    );
    try {
      const wrapped = await next.wrap(dek, context);
      await tx.secret.update({
        where: { id: row.id },
        data: {
          wrappedDek: new Uint8Array(wrapped.ciphertext),
          dekIv: new Uint8Array(wrapped.iv),
          dekTag: new Uint8Array(wrapped.tag),
        },
      });
    } finally {
      dek.fill(0);
    }
  }
  return { rewrapped: rows.length };
}

/**
 * How many of this tenant's data keys each provider (and, for Transit, each
 * key version) wrapped. Reads only the wrapping metadata -- nothing is
 * unwrapped and no KMS is called -- so it is safe to run at any time, and it
 * is how an operator knows a migration is finished before removing the old
 * key: `{ local: 0 }` is the proof.
 */
export async function wrappedKeyInventory(tx: TenantClient): Promise<Record<string, number>> {
  const rows = await tx.secret.findMany({ select: { wrappedDek: true, dekIv: true, dekTag: true } });
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const label = describeWrappedKey({
      ciphertext: Buffer.from(row.wrappedDek),
      iv: Buffer.from(row.dekIv),
      tag: Buffer.from(row.dekTag),
    });
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}
