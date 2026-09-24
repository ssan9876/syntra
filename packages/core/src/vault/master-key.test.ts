import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { awsKmsProvider } from './aws-kms.js';
import {
  describeWrappedKey,
  externalMarker,
  fallbackMasterKeyProvider,
  localMasterKeyProvider,
  parseMarker,
} from './master-key.js';
import { fakeKms } from './testing/fake-kms.js';

const tenant = { tenantId: '11111111-1111-4111-8111-111111111111' };

describe('localMasterKeyProvider', () => {
  it('writes exactly 12 bytes of nonce and 16 of tag, which is how its rows are told apart', async () => {
    const provider = localMasterKeyProvider(Buffer.alloc(32, 1));
    const wrapped = await provider.wrap(randomBytes(32));
    expect(wrapped.iv).toHaveLength(12);
    expect(wrapped.tag).toHaveLength(16);
    expect(provider.recognizes(wrapped)).toBe(true);
    expect(describeWrappedKey(wrapped)).toBe('local');
  });

  it('ignores the tenant, so every row written before tenant binding stays readable', async () => {
    const provider = localMasterKeyProvider(Buffer.alloc(32, 1));
    const dek = randomBytes(32);
    const wrapped = await provider.wrap(dek);
    expect((await provider.unwrap(wrapped, tenant)).equals(dek)).toBe(true);
  });

  it('names the provider a foreign row needs instead of failing inside node:crypto', async () => {
    const provider = localMasterKeyProvider(Buffer.alloc(32, 1));
    const foreign = { ciphertext: Buffer.from('vault:v2:abc'), iv: externalMarker('vault-transit', true), tag: Buffer.from('syntra') };
    await expect(provider.unwrap(foreign)).rejects.toThrow(/wrapped by vault-transit:syntra:v2, not by the local MASTER_KEY/);
  });

  it('check() passes with a good key', async () => {
    await expect(localMasterKeyProvider(Buffer.alloc(32, 1)).check()).resolves.toBeUndefined();
  });
});

describe('format markers', () => {
  it('round-trips and is never mistaken for a local nonce', () => {
    for (const provider of ['vault-transit', 'aws-kms']) {
      for (const bound of [true, false]) {
        const iv = externalMarker(provider, bound);
        expect(iv.length).not.toBe(12);
        expect(parseMarker({ ciphertext: Buffer.alloc(0), iv, tag: Buffer.alloc(0) })).toEqual({ provider, bound });
      }
    }
  });
});

describe('fallbackMasterKeyProvider', () => {
  it('wraps with the primary only, and reads rows the old key wrote -- the rotation window', async () => {
    const oldKey = localMasterKeyProvider(Buffer.alloc(32, 1));
    const newKey = localMasterKeyProvider(Buffer.alloc(32, 2));
    const composite = fallbackMasterKeyProvider(newKey, [oldKey]);

    const dekOld = randomBytes(32);
    const oldRow = await oldKey.wrap(dekOld);
    expect((await composite.unwrap(oldRow)).equals(dekOld)).toBe(true);

    const dekNew = randomBytes(32);
    const newRow = await composite.wrap(dekNew);
    // Written under the NEW key: the old one alone cannot read it.
    await expect(oldKey.unwrap(newRow)).rejects.toThrow();
    expect((await newKey.unwrap(newRow)).equals(dekNew)).toBe(true);
  });

  it('reads local rows and KMS rows side by side during a migration', async () => {
    const kms = fakeKms();
    const arn = kms.createKey();
    const aws = awsKmsProvider({ keyId: arn, bindTenant: true, timeoutMs: 1000, client: kms });
    const local = localMasterKeyProvider(Buffer.alloc(32, 1));
    const composite = fallbackMasterKeyProvider(aws, [local]);

    const a = randomBytes(32);
    const b = randomBytes(32);
    const localRow = await local.wrap(a, tenant);
    const kmsRow = await composite.wrap(b, tenant);

    expect(composite.name).toBe('aws-kms');
    expect(describeWrappedKey(kmsRow)).toBe(`aws-kms:${arn}`);
    expect((await composite.unwrap(localRow, tenant)).equals(a)).toBe(true);
    expect((await composite.unwrap(kmsRow, tenant)).equals(b)).toBe(true);
    // The local row never went near KMS: format routing, not trial and error.
    expect(kms.calls.map((c) => c.command)).toEqual(['EncryptCommand', 'DecryptCommand']);
  });

  it('reports the primary failure when no configured key can unwrap a row', async () => {
    const composite = fallbackMasterKeyProvider(localMasterKeyProvider(Buffer.alloc(32, 2)), [
      localMasterKeyProvider(Buffer.alloc(32, 3)),
    ]);
    const orphan = await localMasterKeyProvider(Buffer.alloc(32, 9)).wrap(randomBytes(32));
    await expect(composite.unwrap(orphan)).rejects.toThrow(/auth/i);
  });

  it('refuses a row no configured provider recognises, naming it', async () => {
    const composite = fallbackMasterKeyProvider(localMasterKeyProvider(Buffer.alloc(32, 2)), [
      localMasterKeyProvider(Buffer.alloc(32, 3)),
    ]);
    const row = { ciphertext: Buffer.from('x'), iv: externalMarker('aws-kms', true), tag: Buffer.from('arn:k') };
    await expect(composite.unwrap(row)).rejects.toThrow(/aws-kms:arn:k, which no configured key-management provider recognises/);
  });

  it('checks only the primary: a stale fallback is a rekey problem, not an outage', async () => {
    const kms = fakeKms();
    const arn = kms.createKey();
    const broken = awsKmsProvider({ keyId: arn, bindTenant: true, timeoutMs: 1000, client: kms });
    kms.outage = true;
    const composite = fallbackMasterKeyProvider(localMasterKeyProvider(Buffer.alloc(32, 2)), [broken]);
    await expect(composite.check()).resolves.toBeUndefined();
  });

  it('uses the primary to generate when it can', async () => {
    const kms = fakeKms();
    const arn = kms.createKey();
    const aws = awsKmsProvider({ keyId: arn, bindTenant: true, timeoutMs: 1000, client: kms });
    const composite = fallbackMasterKeyProvider(aws, [localMasterKeyProvider(Buffer.alloc(32, 1))]);
    const { dek, wrapped } = await composite.generate!(tenant);
    expect((await composite.unwrap(wrapped, tenant)).equals(dek)).toBe(true);
  });
});
