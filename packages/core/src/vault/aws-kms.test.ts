import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { awsKmsProvider } from './aws-kms.js';
import { describeWrappedKey, localMasterKeyProvider } from './master-key.js';
import { fakeKms } from './testing/fake-kms.js';

/**
 * AWS KMS against an in-memory KMS that really encrypts (testing/fake-kms.ts),
 * so every refusal asserted here is a refusal the cryptography produced, not
 * one a stub was told to return.
 */
const tenantA = { tenantId: '11111111-1111-4111-8111-111111111111' };
const tenantB = { tenantId: '22222222-2222-4222-8222-222222222222' };

function setup(over: { bindTenant?: boolean } = {}) {
  const kms = fakeKms();
  const arn = kms.createKey('alias/syntra');
  const provider = awsKmsProvider({
    keyId: 'alias/syntra',
    bindTenant: over.bindTenant ?? true,
    timeoutMs: 1000,
    client: kms,
  });
  return { kms, arn, provider };
}

describe('awsKmsProvider', () => {
  it('wraps with Encrypt and unwraps with Decrypt, naming the key and the tenant both times', async () => {
    const { kms, arn, provider } = setup();
    const dek = randomBytes(32);
    const wrapped = await provider.wrap(dek, tenantA);
    const back = await provider.unwrap(wrapped, tenantA);

    expect(back.equals(dek)).toBe(true);
    expect(kms.calls).toEqual([
      { command: 'EncryptCommand', keyId: 'alias/syntra', context: { 'syntra:tenant': tenantA.tenantId } },
      { command: 'DecryptCommand', keyId: 'alias/syntra', context: { 'syntra:tenant': tenantA.tenantId } },
    ]);
    // The row records the ARN KMS actually used, not the alias -- an alias
    // can be repointed, and the record of what sealed a row must not move.
    expect(describeWrappedKey(wrapped)).toBe(`aws-kms:${arn}`);
    expect(wrapped.iv.toString('ascii')).toBe('aws-kms;ctx=tenant');
  });

  it('mints data keys with GenerateDataKey, one round trip for a write', async () => {
    const { kms, provider } = setup();
    const { dek, wrapped } = await provider.generate!(tenantA);
    expect(dek.length).toBe(32);
    expect((await provider.unwrap(wrapped, tenantA)).equals(dek)).toBe(true);
    expect(kms.calls[0]).toMatchObject({ command: 'GenerateDataKeyCommand', context: { 'syntra:tenant': tenantA.tenantId } });
  });

  it("refuses to unwrap one tenant's data key as another's", async () => {
    const { provider } = setup();
    const wrapped = await provider.wrap(randomBytes(32), tenantA);
    await expect(provider.unwrap(wrapped, tenantB)).rejects.toThrow(/InvalidCiphertextException/);
  });

  it('refuses a blob sealed under a different KMS key, even one it may use', async () => {
    const { kms, provider } = setup();
    const other = kms.createKey();
    const foreign = awsKmsProvider({ keyId: other, bindTenant: true, timeoutMs: 1000, client: kms });
    const wrapped = await foreign.wrap(randomBytes(32), tenantA);
    await expect(provider.unwrap(wrapped, tenantA)).rejects.toThrow(/IncorrectKeyException/);
  });

  it('keeps the KMS error name when the key is revoked, which is what the runbook keys on', async () => {
    const { kms, arn, provider } = setup();
    const wrapped = await provider.wrap(randomBytes(32), tenantA);
    kms.disable(arn);
    await expect(provider.unwrap(wrapped, tenantA)).rejects.toThrow(/aws-kms: Decrypt failed: DisabledException/);
    await expect(provider.check()).rejects.toThrow(/DisabledException/);
  });

  it('binds no context when AWS_KMS_ENCRYPTION_CONTEXT=none, and records that on the row', async () => {
    const { kms, provider } = setup({ bindTenant: false });
    const wrapped = await provider.wrap(randomBytes(32), tenantA);
    expect(wrapped.iv.toString('ascii')).toBe('aws-kms;ctx=none');
    expect(kms.calls[0]!.context).toBeUndefined();
    // Readable from any tenant context: the row says it was never bound.
    await expect(provider.unwrap(wrapped, tenantB)).resolves.toHaveLength(32);
  });

  it('follows the row, not today\'s setting: a bound row is still unwrapped with its context', async () => {
    const kms = fakeKms();
    kms.createKey('alias/syntra');
    const bound = awsKmsProvider({ keyId: 'alias/syntra', bindTenant: true, timeoutMs: 1000, client: kms });
    const unbound = awsKmsProvider({ keyId: 'alias/syntra', bindTenant: false, timeoutMs: 1000, client: kms });
    const dek = randomBytes(32);
    const wrapped = await bound.wrap(dek, tenantA);
    expect((await unbound.unwrap(wrapped, tenantA)).equals(dek)).toBe(true);
  });

  it('refuses a bound row when no tenant is given, rather than asking KMS a question it will refuse', async () => {
    const { provider } = setup();
    const wrapped = await provider.wrap(randomBytes(32), tenantA);
    await expect(provider.unwrap(wrapped)).rejects.toThrow(/bound to a tenant/);
  });

  it('recognises only its own rows, and says so rather than sending a local row to KMS', async () => {
    const { kms, provider } = setup();
    const local = await localMasterKeyProvider(Buffer.alloc(32, 1)).wrap(randomBytes(32));
    expect(provider.recognizes(local)).toBe(false);
    await expect(provider.unwrap(local, tenantA)).rejects.toThrow(/not wrapped by AWS KMS/);
    expect(kms.calls).toEqual([]);
  });

  it('check() round-trips a canary and fails when KMS does not answer', async () => {
    const { kms, provider } = setup();
    await expect(provider.check()).resolves.toBeUndefined();
    kms.outage = true;
    await expect(provider.check()).rejects.toThrow(/aws-kms: Encrypt failed: TimeoutError/);
  });

  it('never puts the data key in an error message', async () => {
    const { kms, provider } = setup();
    const dek = randomBytes(32);
    kms.outage = true;
    const error = await provider.wrap(dek, tenantA).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain(dek.toString('base64'));
    expect(String((error as Error).message)).not.toContain(dek.toString('hex'));
  });
});
