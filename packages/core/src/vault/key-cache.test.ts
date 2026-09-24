import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { awsKmsProvider } from './aws-kms.js';
import { cachingMasterKeyProvider } from './key-cache.js';
import { fakeKms } from './testing/fake-kms.js';

const tenantA = { tenantId: '11111111-1111-4111-8111-111111111111' };
const tenantB = { tenantId: '22222222-2222-4222-8222-222222222222' };

function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  const kms = fakeKms();
  const arn = kms.createKey();
  const inner = awsKmsProvider({ keyId: arn, bindTenant: true, timeoutMs: 1000, client: kms });
  let clock = 1_000_000;
  const cache = cachingMasterKeyProvider(inner, {
    ttlMs: options.ttlMs ?? 60_000,
    maxEntries: options.maxEntries ?? 10,
    now: () => clock,
  });
  const decrypts = () => kms.calls.filter((c) => c.command === 'DecryptCommand').length;
  return { kms, arn, cache, decrypts, advance: (ms: number) => (clock += ms) };
}

describe('cachingMasterKeyProvider', () => {
  it('answers a repeated unwrap from memory', async () => {
    const { cache, decrypts } = setup();
    const dek = randomBytes(32);
    const wrapped = await cache.wrap(dek, tenantA);
    expect((await cache.unwrap(wrapped, tenantA)).equals(dek)).toBe(true);
    expect((await cache.unwrap(wrapped, tenantA)).equals(dek)).toBe(true);
    expect(decrypts()).toBe(1);
  });

  it('hands out copies: a caller zeroing its key does not poison the next read', async () => {
    const { cache } = setup();
    const dek = randomBytes(32);
    const wrapped = await cache.wrap(dek, tenantA);
    (await cache.unwrap(wrapped, tenantA)).fill(0);
    const again = await cache.unwrap(wrapped, tenantA);
    again.fill(0);
    expect((await cache.unwrap(wrapped, tenantA)).equals(dek)).toBe(true);
  });

  it('expires entries after the TTL and goes back to the KMS', async () => {
    const { cache, decrypts, advance } = setup({ ttlMs: 1000 });
    const wrapped = await cache.wrap(randomBytes(32), tenantA);
    await cache.unwrap(wrapped, tenantA);
    advance(1001);
    await cache.unwrap(wrapped, tenantA);
    expect(decrypts()).toBe(2);
  });

  it('holds at most maxEntries keys, evicting the least recently used', async () => {
    const { cache, decrypts } = setup({ maxEntries: 2 });
    const a = await cache.wrap(randomBytes(32), tenantA);
    const b = await cache.wrap(randomBytes(32), tenantA);
    const c = await cache.wrap(randomBytes(32), tenantA);
    await cache.unwrap(a, tenantA);
    await cache.unwrap(b, tenantA);
    await cache.unwrap(a, tenantA); // a is now the most recent
    await cache.unwrap(c, tenantA); // evicts b
    expect(cache.size).toBe(2);
    const before = decrypts();
    await cache.unwrap(a, tenantA);
    expect(decrypts()).toBe(before);
    await cache.unwrap(b, tenantA);
    expect(decrypts()).toBe(before + 1);
  });

  it('keys on the tenant too, so a replayed row goes to the KMS and is refused there', async () => {
    const { cache } = setup();
    const wrapped = await cache.wrap(randomBytes(32), tenantA);
    await cache.unwrap(wrapped, tenantA);
    await expect(cache.unwrap(wrapped, tenantB)).rejects.toThrow(/InvalidCiphertextException/);
  });

  describe('during a KMS outage -- the behaviour docs/configure.md promises', () => {
    it('keeps serving keys unwrapped within the TTL, then stops', async () => {
      const { kms, cache, advance } = setup({ ttlMs: 1000 });
      const dek = randomBytes(32);
      const wrapped = await cache.wrap(dek, tenantA);
      await cache.unwrap(wrapped, tenantA);

      kms.outage = true;
      expect((await cache.unwrap(wrapped, tenantA)).equals(dek)).toBe(true);
      advance(1001);
      await expect(cache.unwrap(wrapped, tenantA)).rejects.toThrow(/TimeoutError/);
    });

    it('fails an uncached read and every write at once', async () => {
      const { kms, cache } = setup();
      const cold = await cache.wrap(randomBytes(32), tenantA);
      kms.outage = true;
      await expect(cache.unwrap(cold, tenantA)).rejects.toThrow(/TimeoutError/);
      await expect(cache.wrap(randomBytes(32), tenantA)).rejects.toThrow(/TimeoutError/);
      await expect(cache.generate!(tenantA)).rejects.toThrow(/TimeoutError/);
    });

    it('fails check() even when every key it needs is cached', async () => {
      const { kms, cache } = setup();
      const wrapped = await cache.wrap(randomBytes(32), tenantA);
      await cache.unwrap(wrapped, tenantA);
      kms.outage = true;
      await expect(cache.check()).rejects.toThrow(/TimeoutError/);
    });
  });

  it('remembers a passing check briefly, and never a failing one', async () => {
    const { kms, cache, advance } = setup();
    await cache.check();
    const calls = kms.calls.length;
    await cache.check();
    expect(kms.calls.length).toBe(calls);

    advance(30_001);
    kms.outage = true;
    await expect(cache.check()).rejects.toThrow();
    kms.outage = false;
    await expect(cache.check()).resolves.toBeUndefined();
  });

  it('is off at a TTL of 0', async () => {
    const { cache, decrypts } = setup({ ttlMs: 0 });
    const wrapped = await cache.wrap(randomBytes(32), tenantA);
    await cache.unwrap(wrapped, tenantA);
    await cache.unwrap(wrapped, tenantA);
    expect(decrypts()).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('clear() drops every key -- what a restart does', async () => {
    const { cache, decrypts } = setup();
    const wrapped = await cache.wrap(randomBytes(32), tenantA);
    await cache.unwrap(wrapped, tenantA);
    cache.clear();
    expect(cache.size).toBe(0);
    await cache.unwrap(wrapped, tenantA);
    expect(decrypts()).toBe(2);
  });
});
