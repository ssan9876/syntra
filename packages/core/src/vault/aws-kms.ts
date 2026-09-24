import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import {
  externalMarker,
  parseMarker,
  roundTrip,
  type KeyContext,
  type MasterKeyProvider,
  type WrappedKey,
} from './master-key.js';

export const AWS_KMS = 'aws-kms';

/** The subset of `KMSClient` this provider uses, so the tests can hand in a fake. */
export interface KmsLike {
  send(command: EncryptCommand | DecryptCommand | GenerateDataKeyCommand): Promise<unknown>;
}

export interface AwsKmsOptions {
  /**
   * A key ARN, key id, alias name (`alias/syntra`) or alias ARN. An ARN is the
   * right answer in production: it pins the account and region, where a bare
   * alias follows whatever the alias is repointed to.
   */
  keyId: string;
  /** Bind each data key to its tenant through the KMS encryption context. */
  bindTenant: boolean;
  /** Defaults to the SDK's own resolution (`AWS_REGION`, the profile, IMDS). */
  region?: string | undefined;
  /** LocalStack or a VPC endpoint. */
  endpoint?: string | undefined;
  timeoutMs: number;
  /** Replaced by the unit tests. */
  client?: KmsLike;
}

/**
 * The encryption context. KMS requires the SAME map at decrypt, and CloudTrail
 * records it in clear on every Encrypt, Decrypt and GenerateDataKey -- which
 * is what makes "which tenant's secret did this process read, and when" a
 * question the KMS's own log answers without Syntra logging anything.
 */
function encryptionContext(context: KeyContext | undefined): Record<string, string> | undefined {
  return context ? { 'syntra:tenant': context.tenantId } : undefined;
}

/**
 * AWS KMS as the master key.
 *
 * Symmetric envelope encryption: `wrap` is `Encrypt` of the data key under the
 * configured KMS key, `unwrap` is `Decrypt`, and `generate` is
 * `GenerateDataKey` (AES_256), which mints the data key inside KMS and returns
 * both halves in one call -- so the common write path is one round trip, and
 * the data key's entropy comes from the KMS's HSMs rather than this process.
 *
 * `Decrypt` names the KeyId even though a symmetric ciphertext blob already
 * carries it: KMS then refuses a blob sealed under ANY other key
 * (`IncorrectKeyException`) rather than decrypting it with whatever key the
 * blob points at, which AWS recommends and which stops a row doctored to
 * reference an attacker-controlled key that happens to be shared with us.
 *
 * KEY VERSIONING is KMS automatic rotation: rotating the backing material
 * keeps the key id, and every old version keeps decrypting, so no rekey is
 * needed for it. Moving to a DIFFERENT key (a new key id) is a rekey:
 * configure `AWS_KMS_PREVIOUS_KEY_ID`, run `rekey`, then remove it. REVOCATION
 * is disabling the key, scheduling its deletion, or removing Syntra's
 * `kms:Decrypt` grant; this provider surfaces each as its KMS error name
 * (`DisabledException`, `KMSInvalidStateException`, `AccessDeniedException`).
 */
export function awsKmsProvider(options: AwsKmsOptions): MasterKeyProvider {
  const client: KmsLike =
    options.client ??
    new KMSClient({
      ...(options.region ? { region: options.region } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      // Three attempts is the SDK default; bounding each one keeps a stalled
      // endpoint from holding a sign-in open for minutes.
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: options.timeoutMs,
        requestTimeout: options.timeoutMs,
      },
    });

  /**
   * A KMS error with its NAME kept, which is the part an operator acts on.
   * The SDK's messages never contain plaintext; the request is not echoed.
   */
  const explain = (operation: string, cause: unknown): Error => {
    const name = (cause as { name?: string } | null)?.name ?? 'Error';
    const message = cause instanceof Error ? cause.message : String(cause);
    return new Error(`aws-kms: ${operation} failed: ${name}: ${message.split('\n')[0]!.slice(0, 200)}`, { cause });
  };

  const provider: MasterKeyProvider = {
    name: AWS_KMS,

    async wrap(dek, context) {
      const bound = options.bindTenant && context !== undefined;
      const ctx = bound ? encryptionContext(context) : undefined;
      let answer: { CiphertextBlob?: Uint8Array; KeyId?: string };
      try {
        answer = (await client.send(
          new EncryptCommand({
            KeyId: options.keyId,
            Plaintext: dek,
            ...(ctx ? { EncryptionContext: ctx } : {}),
          }),
        )) as typeof answer;
      } catch (cause) {
        throw explain('Encrypt', cause);
      }
      if (!answer.CiphertextBlob) throw new Error('aws-kms: Encrypt returned no ciphertext');
      return {
        ciphertext: Buffer.from(answer.CiphertextBlob),
        iv: externalMarker(AWS_KMS, bound),
        // The key ARN KMS actually used, not the alias we asked for: the
        // record of which key sealed this row must not move if the alias does.
        tag: Buffer.from(answer.KeyId ?? options.keyId, 'utf8'),
      };
    },

    async generate(context) {
      const bound = options.bindTenant && context !== undefined;
      const ctx = bound ? encryptionContext(context) : undefined;
      let answer: { CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array; KeyId?: string };
      try {
        answer = (await client.send(
          new GenerateDataKeyCommand({
            KeyId: options.keyId,
            KeySpec: 'AES_256',
            ...(ctx ? { EncryptionContext: ctx } : {}),
          }),
        )) as typeof answer;
      } catch (cause) {
        throw explain('GenerateDataKey', cause);
      }
      if (!answer.CiphertextBlob || !answer.Plaintext) {
        throw new Error('aws-kms: GenerateDataKey returned no key');
      }
      const dek = Buffer.from(answer.Plaintext);
      // The SDK's own copy is zeroed as soon as ours exists.
      answer.Plaintext.fill(0);
      return {
        dek,
        wrapped: {
          ciphertext: Buffer.from(answer.CiphertextBlob),
          iv: externalMarker(AWS_KMS, bound),
          tag: Buffer.from(answer.KeyId ?? options.keyId, 'utf8'),
        },
      };
    },

    async unwrap(wrapped: WrappedKey, context) {
      const marker = parseMarker(wrapped);
      if (marker?.provider !== AWS_KMS) {
        throw new Error('aws-kms: this data key was not wrapped by AWS KMS');
      }
      if (marker.bound && !context) {
        throw new Error('aws-kms: this data key is bound to a tenant, and none was given');
      }
      const ctx = marker.bound ? encryptionContext(context) : undefined;
      let answer: { Plaintext?: Uint8Array };
      try {
        answer = (await client.send(
          new DecryptCommand({
            KeyId: options.keyId,
            CiphertextBlob: wrapped.ciphertext,
            ...(ctx ? { EncryptionContext: ctx } : {}),
          }),
        )) as typeof answer;
      } catch (cause) {
        throw explain('Decrypt', cause);
      }
      if (!answer.Plaintext) throw new Error('aws-kms: Decrypt returned no plaintext');
      const dek = Buffer.from(answer.Plaintext);
      answer.Plaintext.fill(0);
      if (dek.length !== 32) {
        dek.fill(0);
        throw new Error('aws-kms: Decrypt returned a data key of the wrong length');
      }
      return dek;
    },

    recognizes(wrapped) {
      return parseMarker(wrapped)?.provider === AWS_KMS;
    },

    async check() {
      await roundTrip(provider);
    },
  };
  return provider;
}
