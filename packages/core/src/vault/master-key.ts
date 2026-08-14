import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface WrappedKey {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export interface MasterKeyProvider {
  wrap(dek: Buffer): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey): Promise<Buffer>;
}

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

  return {
    async wrap(dek) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      return { ciphertext, iv, tag: cipher.getAuthTag() };
    },

    async unwrap(wrapped) {
      const decipher = createDecipheriv('aes-256-gcm', masterKey, wrapped.iv);
      decipher.setAuthTag(wrapped.tag);
      return Buffer.concat([
        decipher.update(wrapped.ciphertext),
        decipher.final(),
      ]);
    },
  };
}
