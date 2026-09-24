import { createHash } from 'node:crypto';
import type { KeyContext, MasterKeyProvider, WrappedKey } from './master-key.js';

/**
 * How long, and how many, unwrapped data keys a process keeps.
 *
 * `ttlMs` of 0 turns the cache off: every unwrap is a round trip to the KMS.
 */
export interface KeyCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /**
   * How long a passing `check()` is believed. `/health/ready` is polled every
   * few seconds by an orchestrator, and a KMS round trip per poll is money and
   * rate limit spent proving the same thing. A FAILURE is never remembered.
   */
  checkTtlMs?: number;
  /** Overridden by the tests only. */
  now?: () => number;
}

interface Entry {
  dek: Buffer;
  expiresAt: number;
}

/**
 * A bounded, time-limited cache of UNWRAPPED data keys in front of an external
 * provider.
 *
 * Why it exists: every `getSecret` unwraps its data key, and against a KMS
 * that is a network round trip -- on the sign-in path, per SAML assertion
 * signed. The cache turns the steady state into one KMS call per key per TTL.
 *
 * What it does to a KMS OUTAGE, which is the behaviour this is really here to
 * define (docs/configure.md, "Key management", says the same in prose):
 *
 *  - reads of a secret whose data key was unwrapped within the last TTL keep
 *    working until that entry expires; after that they fail;
 *  - reads of anything not cached fail immediately;
 *  - WRITES FAIL IMMEDIATELY. `wrap` and `generate` are never cached -- a new
 *    data key must be sealed by the KMS before it is stored, or it could not
 *    be read back by any other process;
 *  - `check()` fails, so `/health/ready` reports the `key-management` probe.
 *
 * What it does to REVOCATION: disabling the key, revoking Syntra's grant or
 * raising Transit's `min_decryption_version` takes effect for cached entries
 * only when they expire -- at most one TTL. A restart empties the cache at
 * once, and is the step the runbooks give when "now" matters.
 *
 * Entries are keyed by a SHA-256 of the wrapped bytes AND the tenant, so a
 * wrapped key replayed under a different tenant misses the cache and goes to
 * the KMS, which refuses it on the encryption context. Evicted and expired
 * keys are zeroed; callers get a COPY, because every caller zeroes what it is
 * handed (`vault-service.ts`), and zeroing the cached original would poison
 * the next read.
 */
export function cachingMasterKeyProvider(
  inner: MasterKeyProvider,
  options: KeyCacheOptions,
): MasterKeyProvider & { clear(): void; readonly size: number } {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let checkedUntil = 0;

  const drop = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entry.dek.fill(0);
    entries.delete(key);
  };

  const cacheKey = (wrapped: WrappedKey, context?: KeyContext) =>
    createHash('sha256')
      .update(wrapped.ciphertext)
      .update('\0')
      .update(wrapped.iv)
      .update('\0')
      .update(wrapped.tag)
      .update('\0')
      .update(context?.tenantId ?? '')
      .digest('hex');

  const cache = {
    name: inner.name,
    wrap: (dek: Buffer, context?: KeyContext) => inner.wrap(dek, context),
    recognizes: (wrapped: WrappedKey) => inner.recognizes(wrapped),

    async unwrap(wrapped: WrappedKey, context?: KeyContext): Promise<Buffer> {
      if (options.ttlMs <= 0 || options.maxEntries <= 0) {
        return inner.unwrap(wrapped, context);
      }
      const key = cacheKey(wrapped, context);
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) {
        // Re-inserted so Map order is least-recently-USED first, which makes
        // the eviction below an LRU rather than a FIFO.
        entries.delete(key);
        entries.set(key, hit);
        return Buffer.from(hit.dek);
      }
      if (hit) drop(key);

      const dek = await inner.unwrap(wrapped, context);
      entries.set(key, { dek: Buffer.from(dek), expiresAt: now() + options.ttlMs });
      while (entries.size > options.maxEntries) {
        drop(entries.keys().next().value!);
      }
      return dek;
    },

    async check(): Promise<void> {
      if (now() < checkedUntil) return;
      // Straight to the inner provider: a check answered from the cache would
      // report a KMS that has been down for ten minutes as healthy.
      await inner.check();
      checkedUntil = now() + (options.checkTtlMs ?? 30_000);
    },

    clear(): void {
      for (const key of [...entries.keys()]) drop(key);
      checkedUntil = 0;
    },

    get size(): number {
      return entries.size;
    },
  } as MasterKeyProvider & { clear(): void; readonly size: number };

  if (inner.generate) {
    const generate = inner.generate.bind(inner);
    cache.generate = (context?: KeyContext) => generate(context);
  }
  return cache;
}
