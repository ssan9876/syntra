import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from './master-key.js';
import { getSecret, listSecretNames, putSecret } from './vault-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 9));
let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('vault', () => {
  it('round-trips a secret', async () => {
    await withTenant(tenantId, (tx) =>
      putSecret(tx, provider, 'ldap.bindPassword', 'hunter2'),
    );
    const value = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, 'ldap.bindPassword'),
    );
    expect(value).toBe('hunter2');
  });

  it('stores no plaintext anywhere in the row', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'hunter2'));
    const row = await withTenant(tenantId, (tx) =>
      tx.secret.findFirst({ where: { name: 'k' } }),
    );
    const blob = Buffer.concat([row!.ciphertext, row!.wrappedDek]).toString(
      'utf8',
    );
    expect(blob).not.toContain('hunter2');
  });

  it('uses a distinct data key per secret', async () => {
    await withTenant(tenantId, async (tx) => {
      await putSecret(tx, provider, 'a', 'same-value');
      await putSecret(tx, provider, 'b', 'same-value');
    });
    const rows = await withTenant(tenantId, (tx) =>
      tx.secret.findMany({ orderBy: { name: 'asc' } }),
    );
    // Identical plaintext must not produce identical ciphertext, or the store
    // leaks which secrets share a value. Prisma returns Uint8Array for Bytes,
    // so compare through Buffer.
    const bytes = (v: Uint8Array) => Buffer.from(v).toString('hex');
    expect(bytes(rows[0]!.wrappedDek)).not.toBe(bytes(rows[1]!.wrappedDek));
    expect(bytes(rows[0]!.ciphertext)).not.toBe(bytes(rows[1]!.ciphertext));
  });

  it('replaces a secret in place rather than duplicating it', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'first'));
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'second'));

    const rows = await withTenant(tenantId, (tx) => tx.secret.findMany());
    expect(rows).toHaveLength(1);

    const value = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, 'k'),
    );
    expect(value).toBe('second');
  });

  it('rejects a tampered ciphertext instead of returning garbage', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'hunter2'));
    const row = await withTenant(tenantId, (tx) =>
      tx.secret.findFirst({ where: { name: 'k' } }),
    );

    const corrupted = Buffer.from(row!.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    await withTenant(tenantId, (tx) =>
      tx.secret.update({
        where: { id: row!.id },
        data: { ciphertext: corrupted },
      }),
    );

    // GCM authenticates the ciphertext, so a flipped bit fails loudly.
    await expect(
      withTenant(tenantId, (tx) => getSecret(tx, provider, 'k')),
    ).rejects.toThrow();
  });

  it('returns null for an unknown name', async () => {
    const value = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, 'missing'),
    );
    expect(value).toBeNull();
  });

  it('cannot decrypt with a different master key', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'hunter2'));
    const wrong = localMasterKeyProvider(randomBytes(32));
    await expect(
      withTenant(tenantId, (tx) => getSecret(tx, wrong, 'k')),
    ).rejects.toThrow();
  });

  it('lists names and timestamps without exposing any value', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'hunter2'));
    const listed = await withTenant(tenantId, (tx) => listSecretNames(tx));

    expect(listed).toHaveLength(1);
    expect(listed[0]).toHaveProperty('name', 'k');
    expect(JSON.stringify(listed)).not.toContain('hunter2');
    expect(Object.keys(listed[0]!).sort()).toEqual(['id', 'name', 'updatedAt']);
  });

  it('keeps secrets of the same name separate per tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'acme'));
    await withTenant(other.id, (tx) => putSecret(tx, provider, 'k', 'other'));

    expect(
      await withTenant(tenantId, (tx) => getSecret(tx, provider, 'k')),
    ).toBe('acme');
    expect(await withTenant(other.id, (tx) => getSecret(tx, provider, 'k'))).toBe(
      'other',
    );
  });
});

describe('master key provider', () => {
  it('refuses a key that is not 32 bytes', () => {
    expect(() => localMasterKeyProvider(Buffer.alloc(16))).toThrow(
      /32 bytes/,
    );
  });
});
