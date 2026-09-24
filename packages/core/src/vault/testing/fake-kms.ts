import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
} from '@aws-sdk/client-kms';
import type { KmsLike } from '../aws-kms.js';

/**
 * An in-memory stand-in for AWS KMS, for tests only.
 *
 * Not a mock that returns canned answers: it really encrypts, under a real
 * AES-256-GCM key per KMS key id, with the encryption context as AAD -- so a
 * test that passes the wrong tenant, the wrong key or a doctored blob gets the
 * same refusal the real service gives, rather than whatever the test author
 * remembered to stub. The error NAMES match KMS's (`IncorrectKeyException`,
 * `InvalidCiphertextException`, `DisabledException`), because the provider
 * surfaces them and the runbooks tell operators what each one means.
 *
 * Every call is recorded (`calls`), minus the plaintext, so a test can assert
 * what was sent -- the KeyId and the context -- without the log itself
 * becoming somewhere a data key lives.
 */
export interface FakeKms extends KmsLike {
  calls: { command: string; keyId: string | undefined; context: Record<string, string> | undefined }[];
  /** Adds a key; returns its ARN. */
  createKey(alias?: string): string;
  disable(keyIdOrArn: string): void;
  /** Makes every call fail as if the endpoint were unreachable, until cleared. */
  outage: boolean;
}

const kmsError = (name: string, message: string) => Object.assign(new Error(message), { name });

export function fakeKms(): FakeKms {
  const keys = new Map<string, { key: Buffer; enabled: boolean }>();
  const aliases = new Map<string, string>();
  let counter = 0;

  const resolve = (keyId: string | undefined): string => {
    if (!keyId) throw kmsError('ValidationException', 'KeyId is required');
    const arn = aliases.get(keyId) ?? keyId;
    const entry = keys.get(arn);
    if (!entry) throw kmsError('NotFoundException', `Key '${keyId}' does not exist`);
    if (!entry.enabled) throw kmsError('DisabledException', `${arn} is disabled.`);
    return arn;
  };

  const aad = (context: Record<string, string> | undefined) =>
    Buffer.from(JSON.stringify(Object.entries(context ?? {}).sort()), 'utf8');

  const seal = (arn: string, plaintext: Buffer, context: Record<string, string> | undefined) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keys.get(arn)!.key, iv);
    cipher.setAAD(aad(context));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const id = Buffer.from(arn, 'utf8');
    return Buffer.concat([Buffer.from([id.length]), id, iv, cipher.getAuthTag(), ct]);
  };

  const fake: FakeKms = {
    calls: [],
    outage: false,

    createKey(alias) {
      counter += 1;
      const arn = `arn:aws:kms:eu-west-2:111122223333:key/fake-${counter}`;
      keys.set(arn, { key: randomBytes(32), enabled: true });
      if (alias) aliases.set(alias, arn);
      return arn;
    },

    disable(keyIdOrArn) {
      keys.get(aliases.get(keyIdOrArn) ?? keyIdOrArn)!.enabled = false;
    },

    async send(command) {
      const input = command.input as {
        KeyId?: string;
        EncryptionContext?: Record<string, string>;
        Plaintext?: Uint8Array;
        CiphertextBlob?: Uint8Array;
      };
      const name = command.constructor.name;
      fake.calls.push({ command: name, keyId: input.KeyId, context: input.EncryptionContext });
      if (fake.outage) {
        throw kmsError('TimeoutError', 'connect ETIMEDOUT kms.eu-west-2.amazonaws.com:443');
      }

      if (command instanceof EncryptCommand) {
        const arn = resolve(input.KeyId);
        return { KeyId: arn, CiphertextBlob: new Uint8Array(seal(arn, Buffer.from(input.Plaintext!), input.EncryptionContext)) };
      }
      if (command instanceof GenerateDataKeyCommand) {
        const arn = resolve(input.KeyId);
        const dek = randomBytes(32);
        return {
          KeyId: arn,
          Plaintext: new Uint8Array(dek),
          CiphertextBlob: new Uint8Array(seal(arn, dek, input.EncryptionContext)),
        };
      }
      if (command instanceof DecryptCommand) {
        const blob = Buffer.from(input.CiphertextBlob!);
        const idLength = blob[0]!;
        const arn = blob.subarray(1, 1 + idLength).toString('utf8');
        if (input.KeyId && resolve(input.KeyId) !== arn) {
          throw kmsError('IncorrectKeyException', 'The key ID in the request does not identify a CMK that can perform this operation.');
        }
        resolve(arn);
        const rest = blob.subarray(1 + idLength);
        const decipher = createDecipheriv('aes-256-gcm', keys.get(arn)!.key, rest.subarray(0, 12));
        decipher.setAAD(aad(input.EncryptionContext));
        decipher.setAuthTag(rest.subarray(12, 28));
        try {
          const plaintext = Buffer.concat([decipher.update(rest.subarray(28)), decipher.final()]);
          return { KeyId: arn, Plaintext: new Uint8Array(plaintext) };
        } catch {
          throw kmsError('InvalidCiphertextException', '');
        }
      }
      throw new Error(`fake KMS does not implement ${name}`);
    },
  };
  return fake;
}
