import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { BackupArchiveError, createBackupDecryptor, createBackupEncryptor, FRAME_SIZE } from './archive.js';

const passphrase = 'correct horse battery staple';
const manifest = { createdAt: '2026-10-05T02:00:00Z', version: '1.20.0' };
const HEADER = 8 + 4 + 16 + 8;
const FRAME = 4 + FRAME_SIZE + 16;

function* pieces(buffer: Buffer) {
  for (let i = 0; i < buffer.length; i += 7777) yield buffer.subarray(i, i + 7777);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

async function encrypt(data: Buffer, pass = passphrase): Promise<Buffer> {
  const encryptor = await createBackupEncryptor(pass, manifest);
  const out = collect(encryptor);
  await pipeline(Readable.from(pieces(data)), encryptor);
  return out;
}

async function decrypt(file: Buffer, pass = passphrase) {
  const decryptor = createBackupDecryptor(pass);
  const out = collect(decryptor);
  out.catch(() => undefined);
  await pipeline(Readable.from(pieces(file)), decryptor);
  return { data: await out, manifest: await decryptor.manifest };
}

async function reason(file: Buffer, pass = passphrase): Promise<string> {
  try {
    await decrypt(file, pass);
    return 'accepted';
  } catch (err) {
    return err instanceof BackupArchiveError ? err.reason : String(err);
  }
}

describe('backup archive', () => {
  it.each([0, 1, FRAME_SIZE - 9, FRAME_SIZE, 3 * FRAME_SIZE + 5])(
    'round-trips %i bytes with the manifest',
    async (size) => {
      const data = randomBytes(size);
      const back = await decrypt(await encrypt(data));
      expect(back.data.equals(data)).toBe(true);
      expect(back.manifest).toEqual(manifest);
    },
  );

  describe('refuses', () => {
    let file: Buffer;
    beforeAll(async () => {
      file = await encrypt(randomBytes(3 * FRAME_SIZE + 100));
    });

    it('a wrong passphrase', async () => {
      expect(await reason(file, 'a different passphrase')).toBe('wrong-passphrase');
    });

    it('a file cut short at a frame boundary or mid-frame', async () => {
      expect(await reason(file.subarray(0, HEADER + 2 * FRAME))).toBe('incomplete');
      expect(await reason(file.subarray(0, file.length - 10))).toBe('incomplete');
    });

    it('a flipped bit, swapped frames and trailing bytes', async () => {
      const flipped = Buffer.from(file);
      flipped[HEADER + FRAME + 100] = flipped[HEADER + FRAME + 100]! ^ 1;
      expect(await reason(flipped)).toBe('damaged');
      const swapped = Buffer.concat([
        file.subarray(0, HEADER),
        file.subarray(HEADER + FRAME, HEADER + 2 * FRAME),
        file.subarray(HEADER, HEADER + FRAME),
        file.subarray(HEADER + 2 * FRAME),
      ]);
      expect(await reason(swapped)).not.toBe('accepted');
      expect(await reason(Buffer.concat([file, Buffer.from('xyz')]))).toBe('damaged');
    });

    it('a file that is not a backup', async () => {
      expect(await reason(Buffer.from('PGDMP'.padEnd(200, 'x')))).toBe('not-an-archive');
    });

    it('a passphrase shorter than 12 characters', async () => {
      await expect(createBackupEncryptor('short', manifest)).rejects.toThrow('at least 12 characters');
    });
  });
});
