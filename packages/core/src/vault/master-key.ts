import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A data key, sealed by whatever holds the master key.
 *
 * The three fields map one-to-one onto `Secret.wrappedDek`, `dekIv` and
 * `dekTag`, and the shape predates any provider but the local one -- so an
 * external provider REUSES the columns rather than migrating them:
 *
 *  - `ciphertext` is the provider's own sealed blob (AES-GCM output for the
 *    local provider, a `vault:vN:…` string for Vault Transit, a KMS
 *    `CiphertextBlob` for AWS);
 *  - `iv` is the local provider's 12-byte nonce, or, for an external provider,
 *    an ASCII FORMAT MARKER such as `vault-transit;ad=tenant` (see
 *    `externalMarker`);
 *  - `tag` is the local provider's 16-byte GCM tag, or, for an external
 *    provider, the key reference it was wrapped under (informational -- the
 *    reference the operator reads in `rekey --status`, never an input the
 *    provider trusts over its own configuration).
 *
 * The lengths are what make the two readable side by side: a local row is
 * always exactly 12 + 16 bytes of nonce and tag, and no marker is 12 bytes
 * long. That is what lets a deployment mid-migration read both kinds of row
 * without a schema change and without guessing.
 */
export interface WrappedKey {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * What a data key is bound to.
 *
 * A KMS provider passes the tenant id as AAD / encryption context, so a
 * wrapped key copied from one tenant's row into another's refuses to unwrap
 * rather than handing the second tenant the first tenant's secret -- and, as a
 * side effect worth as much, the KMS's own access log names the tenant whose
 * key was used. The local provider ignores it: binding it now would make every
 * existing row unreadable.
 */
export interface KeyContext {
  tenantId: string;
}

export interface MasterKeyProvider {
  /**
   * `local`, `vault-transit` or `aws-kms`. A composite reports its primary's
   * name, because that is the provider new keys are wrapped under.
   */
  readonly name: string;
  wrap(dek: Buffer, context?: KeyContext): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, context?: KeyContext): Promise<Buffer>;
  /**
   * Whether this provider could have produced `wrapped`, from its FORMAT
   * alone. Never a decryption attempt -- the fallback composite uses it to
   * pick which providers to try, and the rekey status uses it to count rows.
   */
  recognizes(wrapped: WrappedKey): boolean;
  /**
   * Mints a data key and its wrapped form in one round trip, where the
   * provider has such a call (AWS `GenerateDataKey`). Optional: without it
   * `putSecret` generates the key locally and calls `wrap`, which costs the
   * same single call to an external provider.
   */
  generate?(context?: KeyContext): Promise<{ dek: Buffer; wrapped: WrappedKey }>;
  /**
   * Proves the master key is usable RIGHT NOW: wraps a random canary and
   * unwraps it again, bypassing every cache. Throws with a message safe to
   * log; never includes key material. The readiness probe calls this.
   */
  check(): Promise<void>;
}

/** The byte lengths only the local provider's rows have. */
const LOCAL_IV_BYTES = 12;
const LOCAL_TAG_BYTES = 16;

/**
 * Development and single-node provider: the master key comes from
 * configuration. A KMS-backed provider implements this same interface without
 * any caller changing, which is the point of the indirection — the data keys
 * never leave the process, and only the wrapping moves.
 */
export function localMasterKeyProvider(masterKey: Buffer): MasterKeyProvider {
  if (masterKey.length !== 32) {
    throw new Error('master key must be 32 bytes');
  }

  const provider: MasterKeyProvider = {
    name: 'local',

    async wrap(dek) {
      const iv = randomBytes(LOCAL_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      return { ciphertext, iv, tag: cipher.getAuthTag() };
    },

    async unwrap(wrapped) {
      if (!provider.recognizes(wrapped)) {
        // Without this, a row an external provider wrapped fails deep inside
        // node:crypto with "Invalid authentication tag length", which tells an
        // operator nothing about the fix.
        throw new Error(
          `this data key was wrapped by ${describeWrappedKey(wrapped)}, not by the local MASTER_KEY; configure that provider (see docs/configure.md, "Key management")`,
        );
      }
      const decipher = createDecipheriv('aes-256-gcm', masterKey, wrapped.iv);
      decipher.setAuthTag(wrapped.tag);
      return Buffer.concat([
        decipher.update(wrapped.ciphertext),
        decipher.final(),
      ]);
    },

    recognizes(wrapped) {
      return wrapped.iv.length === LOCAL_IV_BYTES && wrapped.tag.length === LOCAL_TAG_BYTES;
    },

    async check() {
      await roundTrip(provider);
    },
  };
  return provider;
}

/**
 * The format marker an external provider writes into `dekIv`.
 *
 * `ctx=tenant` records that the key was bound to its tenant, so the unwrap
 * supplies the same binding whatever the configuration says today: flipping
 * `AWS_KMS_ENCRYPTION_CONTEXT` must not strand the rows written before the
 * flip. A marker is never 12 bytes, so it cannot be mistaken for a local nonce.
 */
export function externalMarker(provider: string, bound: boolean): Buffer {
  return Buffer.from(`${provider};ctx=${bound ? 'tenant' : 'none'}`, 'ascii');
}

export interface ParsedMarker {
  provider: string;
  bound: boolean;
}

export function parseMarker(wrapped: WrappedKey): ParsedMarker | null {
  if (wrapped.iv.length === LOCAL_IV_BYTES) return null;
  const text = wrapped.iv.toString('ascii');
  const match = /^([a-z0-9-]+);ctx=(tenant|none)$/.exec(text);
  if (!match) return null;
  return { provider: match[1]!, bound: match[2] === 'tenant' };
}

/**
 * One line naming what wrapped a key, for errors and for `rekey --status`.
 * Built only from the marker, the recorded key reference and -- for Vault --
 * the `vault:vN:` version prefix; never from anything secret.
 */
export function describeWrappedKey(wrapped: WrappedKey): string {
  if (wrapped.iv.length === LOCAL_IV_BYTES && wrapped.tag.length === LOCAL_TAG_BYTES) {
    return 'local';
  }
  const marker = parseMarker(wrapped);
  if (!marker) return 'an unrecognised provider';
  const keyRef = wrapped.tag.toString('utf8');
  if (marker.provider === 'vault-transit') {
    const version = /^vault:(v\d+):/.exec(wrapped.ciphertext.toString('utf8'))?.[1] ?? 'v?';
    return `vault-transit:${keyRef}:${version}`;
  }
  return `${marker.provider}:${keyRef}`;
}

/**
 * Wrap a random canary and unwrap it again. The canary is random so nothing
 * can be precomputed, and compared in constant time so a check that "passes"
 * genuinely got the same bytes back. Both copies are zeroed before returning.
 */
export async function roundTrip(provider: MasterKeyProvider): Promise<void> {
  const canary = randomBytes(32);
  let back: Buffer | undefined;
  try {
    const wrapped = await provider.wrap(canary);
    back = await provider.unwrap(wrapped);
    if (back.length !== canary.length || !timingSafeEqual(back, canary)) {
      throw new Error(`${provider.name}: the canary data key did not survive a wrap and unwrap`);
    }
  } finally {
    canary.fill(0);
    back?.fill(0);
  }
}

/**
 * The provider a deployment runs mid-migration or mid-rotation: new keys are
 * wrapped under `primary`, and existing ones are unwrapped by whichever
 * provider recognises their format -- the primary first, then each fallback in
 * order, with the first success winning.
 *
 * Trying more than one is safe because every provider here AUTHENTICATES: a
 * wrong local key fails the GCM tag, a wrong Transit key fails Vault's own
 * AEAD, a wrong KMS key is `IncorrectKeyException`. There is no "wrong key
 * that decrypts to garbage" to worry about.
 *
 * The fallbacks are decrypt-only BY CONSTRUCTION: nothing here ever calls
 * their `wrap`. That is what makes it safe to leave the old key configured
 * while `rekey` runs, and why removing it afterwards is a pure reduction.
 */
export function fallbackMasterKeyProvider(
  primary: MasterKeyProvider,
  fallbacks: MasterKeyProvider[],
): MasterKeyProvider {
  if (fallbacks.length === 0) return primary;
  const all = [primary, ...fallbacks];

  const composite: MasterKeyProvider = {
    name: primary.name,
    wrap: (dek, context) => primary.wrap(dek, context),
    async unwrap(wrapped, context) {
      const candidates = all.filter((p) => p.recognizes(wrapped));
      if (candidates.length === 0) {
        throw new Error(
          `this data key was wrapped by ${describeWrappedKey(wrapped)}, which no configured key-management provider recognises`,
        );
      }
      let first: unknown;
      for (const candidate of candidates) {
        try {
          return await candidate.unwrap(wrapped, context);
        } catch (cause) {
          first ??= cause;
        }
      }
      throw first;
    },
    recognizes: (wrapped) => all.some((p) => p.recognizes(wrapped)),
    // Readiness is about the provider new keys go to. A fallback that has
    // already become unreachable is a rekey problem, reported by
    // `rekey --status`, not a reason to take the deployment out of service.
    check: () => primary.check(),
  };
  if (primary.generate) {
    const generate = primary.generate.bind(primary);
    composite.generate = (context) => generate(context);
  }
  return composite;
}
