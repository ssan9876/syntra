import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * A backup as a file to download: the manifest and the `pg_dump` archive,
 * encrypted under a passphrase.
 *
 * The dump holds every person's name and email and the audit log in the
 * clear; only stored credentials are sealed under the master key. A file that
 * leaves the server is therefore encrypted as a whole, with a key nobody but
 * the person downloading it holds.
 *
 * Layout:
 *
 *   header   "SYNTRABK" | version u8 | log2(N) u8 | r u8 | p u8 | salt[16] | noncePrefix[8]
 *   frames   ( length u32 | ciphertext | tag[16] )*
 *
 * Each frame is AES-256-GCM over at most FRAME_SIZE bytes of plaintext, with
 * nonce noncePrefix | index u32 and the header, index and a final flag as
 * additional data. The header is authenticated by every frame; frames cannot
 * be reordered (index); and a file cut short at a frame boundary is detected,
 * because only the last frame carries final = 1.
 *
 * The plaintext is: manifest length u32 | manifest JSON | dump.
 */

const MAGIC = Buffer.from('SYNTRABK', 'ascii');
const VERSION = 1;
const HEADER_LENGTH = MAGIC.length + 4 + 16 + 8;
const TAG_LENGTH = 16;
export const FRAME_SIZE = 64 * 1024;
const MAX_MANIFEST = 64 * 1024;

/** scrypt at ~128 MiB: slow enough to make guessing expensive, fast enough for one download. */
const KDF = { log2N: 17, r: 8, p: 1 };

export const MIN_PASSPHRASE_LENGTH = 12;

export class BackupArchiveError extends Error {
  constructor(
    readonly reason: 'not-an-archive' | 'unsupported-version' | 'wrong-passphrase' | 'damaged' | 'incomplete',
    message: string,
  ) {
    super(message);
    this.name = 'BackupArchiveError';
  }
}

function deriveKey(passphrase: string, salt: Buffer, log2N: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** log2N;
  return new Promise((resolve, reject) => {
    scryptCb(passphrase.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

function nonceFor(prefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, 8);
  return nonce;
}

function aadFor(header: Buffer, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(index, 0);
  tail.writeUInt8(final ? 1 : 0, 4);
  return Buffer.concat([header, tail]);
}

/**
 * Encrypts a dump. Write the dump into the returned stream; read the file out.
 * The manifest goes first, inside the encryption.
 */
export async function createBackupEncryptor(passphrase: string, manifest: unknown): Promise<Transform> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new RangeError(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const noncePrefix = randomBytes(8);
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([VERSION, KDF.log2N, KDF.r, KDF.p]),
    salt,
    noncePrefix,
  ]);
  const key = await deriveKey(passphrase, salt, KDF.log2N, KDF.r, KDF.p);

  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(manifestBytes.length, 0);

  let pending: Buffer = Buffer.concat([lengthPrefix, manifestBytes]);
  let index = 0;

  const seal = (plain: Buffer, final: boolean): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', key, nonceFor(noncePrefix, index));
    cipher.setAAD(aadFor(header, index, final));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    index += 1;
    return Buffer.concat([length, body, cipher.getAuthTag()]);
  };

  let headerSent = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (!headerSent) {
        this.push(header);
        headerSent = true;
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // Keep at least one byte back so the last frame is always the final one.
      while (pending.length > FRAME_SIZE) {
        this.push(seal(pending.subarray(0, FRAME_SIZE), false));
        pending = pending.subarray(FRAME_SIZE);
      }
      callback();
    },
    flush(callback: TransformCallback) {
      if (!headerSent) this.push(header);
      this.push(seal(pending, true));
      callback();
    },
  });
}

/**
 * Decrypts a file written by `createBackupEncryptor`. Write the file in; the
 * dump comes out, and the manifest is delivered through `manifest` before the
 * first byte of it.
 */
export function createBackupDecryptor(passphrase: string): Transform & { manifest: Promise<unknown> } {
  let buffered: Buffer = Buffer.alloc(0);
  let header: Buffer | null = null;
  let key: Buffer | null = null;
  let noncePrefix: Buffer | null = null;
  let index = 0;
  let finished = false;
  let manifestLength: number | null = null;
  let resolveManifest!: (value: unknown) => void;
  let rejectManifest!: (err: Error) => void;
  const manifest = new Promise<unknown>((resolve, reject) => {
    resolveManifest = resolve;
    rejectManifest = reject;
  });
  // Nobody is obliged to await it; an unawaited rejection must not crash.
  manifest.catch(() => undefined);
  let plainBuffered: Buffer = Buffer.alloc(0);
  let manifestDone = false;

  const fail = (_stream: Transform, err: BackupArchiveError, callback: TransformCallback) => {
    rejectManifest(err);
    callback(err);
  };

  const emitPlain = (stream: Transform, plain: Buffer) => {
    if (manifestDone) {
      if (plain.length) stream.push(plain);
      return;
    }
    plainBuffered = Buffer.concat([plainBuffered, plain]);
    if (manifestLength === null && plainBuffered.length >= 4) {
      manifestLength = plainBuffered.readUInt32BE(0);
      if (manifestLength > MAX_MANIFEST) throw new BackupArchiveError('damaged', 'The backup file is damaged.');
    }
    if (manifestLength !== null && plainBuffered.length >= 4 + manifestLength) {
      const json = plainBuffered.subarray(4, 4 + manifestLength).toString('utf8');
      try {
        resolveManifest(JSON.parse(json));
      } catch {
        throw new BackupArchiveError('damaged', 'The backup file is damaged.');
      }
      manifestDone = true;
      const rest = plainBuffered.subarray(4 + manifestLength);
      plainBuffered = Buffer.alloc(0);
      if (rest.length) stream.push(rest);
    }
  };

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      void (async () => {
        try {
          if (!header) {
            if (buffered.length < HEADER_LENGTH) return callback();
            const candidate = buffered.subarray(0, HEADER_LENGTH);
            if (!candidate.subarray(0, MAGIC.length).equals(MAGIC)) {
              return fail(this, new BackupArchiveError('not-an-archive', 'This is not a Syntra backup file.'), callback);
            }
            if (candidate[MAGIC.length] !== VERSION) {
              return fail(this, new BackupArchiveError('unsupported-version', 'This backup file needs a newer version of Syntra.'), callback);
            }
            const log2N = candidate[MAGIC.length + 1]!;
            const r = candidate[MAGIC.length + 2]!;
            const p = candidate[MAGIC.length + 3]!;
            if (log2N < 14 || log2N > 20 || r < 1 || r > 16 || p < 1 || p > 4) {
              return fail(this, new BackupArchiveError('damaged', 'The backup file is damaged.'), callback);
            }
            header = Buffer.from(candidate);
            const salt = header.subarray(MAGIC.length + 4, MAGIC.length + 20);
            noncePrefix = header.subarray(MAGIC.length + 20, HEADER_LENGTH);
            key = await deriveKey(passphrase, salt, log2N, r, p);
            buffered = buffered.subarray(HEADER_LENGTH);
          }
          while (buffered.length >= 4) {
            const length = buffered.readUInt32BE(0);
            if (length > FRAME_SIZE) {
              return fail(this, new BackupArchiveError('damaged', 'The backup file is damaged.'), callback);
            }
            if (buffered.length < 4 + length + TAG_LENGTH) break;
            if (finished) {
              return fail(this, new BackupArchiveError('damaged', 'The backup file is damaged.'), callback);
            }
            const body = buffered.subarray(4, 4 + length);
            const tag = buffered.subarray(4 + length, 4 + length + TAG_LENGTH);
            buffered = buffered.subarray(4 + length + TAG_LENGTH);
            const plain = open(body, tag, false) ?? open(body, tag, true);
            if (!plain) {
              const err = index === 0
                ? new BackupArchiveError('wrong-passphrase', 'Wrong passphrase, or the backup file is damaged.')
                : new BackupArchiveError('damaged', 'The backup file is damaged.');
              return fail(this, err, callback);
            }
            index += 1;
            emitPlain(this, plain.data);
            if (plain.final) finished = true;
          }
          callback();
        } catch (err) {
          const archiveError = err instanceof BackupArchiveError
            ? err
            : new BackupArchiveError('damaged', 'The backup file is damaged.');
          fail(this, archiveError, callback);
        }
      })();
    },
    flush(callback: TransformCallback) {
      if (!finished || buffered.length > 0 || !manifestDone) {
        const err = finished && buffered.length > 0
          ? new BackupArchiveError('damaged', 'The backup file is damaged.')
          : new BackupArchiveError('incomplete', 'The backup file is incomplete.');
        rejectManifest(err);
        return callback(err);
      }
      callback();
    },
  }) as Transform & { manifest: Promise<unknown> };

  function open(body: Buffer, tag: Buffer, final: boolean): { data: Buffer; final: boolean } | null {
    const decipher = createDecipheriv('aes-256-gcm', key!, nonceFor(noncePrefix!, index));
    decipher.setAAD(aadFor(header!, index, final));
    decipher.setAuthTag(tag);
    try {
      return { data: Buffer.concat([decipher.update(body), decipher.final()]), final };
    } catch {
      return null;
    }
  }

  stream.manifest = manifest;
  return stream;
}
