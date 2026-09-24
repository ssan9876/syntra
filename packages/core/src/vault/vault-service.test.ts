import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { awsKmsProvider } from './aws-kms.js';
import { fallbackMasterKeyProvider, localMasterKeyProvider } from './master-key.js';
import { fakeKms } from './testing/fake-kms.js';
import { getSecret, putSecret, rewrapSecrets, wrappedKeyInventory } from './vault-service.js';

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

  it('re-wraps every data key under the next master key without changing plaintext', async () => {
    await withTenant(tenantId, async (tx) => {
      await putSecret(tx, provider, 'a', 'first');
      await putSecret(tx, provider, 'b', 'second');
    });
    const next = localMasterKeyProvider(randomBytes(32));
    const rotated = await withTenant(tenantId, (tx) => rewrapSecrets(tx, provider, next));
    expect(rotated).toEqual({ rewrapped: 2 });
    await expect(withTenant(tenantId, (tx) => getSecret(tx, provider, 'a'))).rejects.toThrow();
    expect(await withTenant(tenantId, (tx) => getSecret(tx, next, 'a'))).toBe('first');
    expect(await withTenant(tenantId, (tx) => getSecret(tx, next, 'b'))).toBe('second');
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

describe('vault with an external master-key provider', () => {
  function kmsSetup() {
    const kms = fakeKms();
    const arn = kms.createKey('alias/syntra');
    const aws = awsKmsProvider({ keyId: 'alias/syntra', bindTenant: true, timeoutMs: 1000, client: kms });
    return { kms, arn, aws };
  }

  it('mints the data key with GenerateDataKey and binds it to the tenant', async () => {
    const { kms, aws } = kmsSetup();
    await withTenant(tenantId, (tx) => putSecret(tx, aws, 'k', 'hunter2'));
    expect(await withTenant(tenantId, (tx) => getSecret(tx, aws, 'k'))).toBe('hunter2');
    expect(kms.calls.map((c) => [c.command, c.context])).toEqual([
      ['GenerateDataKeyCommand', { 'syntra:tenant': tenantId }],
      ['DecryptCommand', { 'syntra:tenant': tenantId }],
    ]);
  });

  it("refuses a wrapped key copied into another tenant's row", async () => {
    const { aws } = kmsSetup();
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await withTenant(tenantId, (tx) => putSecret(tx, aws, 'k', 'acme-only'));
    await withTenant(other.id, (tx) => putSecret(tx, aws, 'k', 'other'));
    // Somebody with write access to the database swaps the rows' sealed
    // halves across tenants. Without tenant binding this would hand Other
    // Acme's secret.
    const acme = await withTenant(tenantId, (tx) => tx.secret.findFirstOrThrow({ where: { name: 'k' } }));
    await withTenant(other.id, (tx) =>
      tx.secret.updateMany({
        where: { name: 'k' },
        data: {
          ciphertext: acme.ciphertext, iv: acme.iv, tag: acme.tag,
          wrappedDek: acme.wrappedDek, dekIv: acme.dekIv, dekTag: acme.dekTag,
        },
      }),
    );
    await expect(withTenant(other.id, (tx) => getSecret(tx, aws, 'k'))).rejects.toThrow(/InvalidCiphertextException/);
  });

  it('migrates local rows to KMS with rewrapSecrets, and the inventory proves it', async () => {
    const { aws, arn } = kmsSetup();
    await withTenant(tenantId, async (tx) => {
      await putSecret(tx, provider, 'a', 'first');
      await putSecret(tx, provider, 'b', 'second');
    });
    // The migration window: new writes go to KMS, old rows still read.
    const composite = fallbackMasterKeyProvider(aws, [provider]);
    await withTenant(tenantId, (tx) => putSecret(tx, composite, 'c', 'third'));
    expect(await withTenant(tenantId, (tx) => wrappedKeyInventory(tx))).toEqual({ local: 2, [`aws-kms:${arn}`]: 1 });

    const moved = await withTenant(tenantId, (tx) => rewrapSecrets(tx, composite, aws));
    expect(moved).toEqual({ rewrapped: 3 });
    expect(await withTenant(tenantId, (tx) => wrappedKeyInventory(tx))).toEqual({ [`aws-kms:${arn}`]: 3 });

    // KMS alone now reads everything; the local key reads nothing.
    for (const [name, value] of [['a', 'first'], ['b', 'second'], ['c', 'third']] as const) {
      expect(await withTenant(tenantId, (tx) => getSecret(tx, aws, name))).toBe(value);
    }
    await expect(withTenant(tenantId, (tx) => getSecret(tx, provider, 'a'))).rejects.toThrow(/not by the local MASTER_KEY/);

    // And running it again is harmless.
    expect(await withTenant(tenantId, (tx) => rewrapSecrets(tx, composite, aws))).toEqual({ rewrapped: 3 });
    expect(await withTenant(tenantId, (tx) => getSecret(tx, aws, 'b'))).toBe('second');
  });
});

describe('master key provider', () => {
  it('refuses a key that is not 32 bytes', () => {
    expect(() => localMasterKeyProvider(Buffer.alloc(16))).toThrow(
      /32 bytes/,
    );
  });
});
