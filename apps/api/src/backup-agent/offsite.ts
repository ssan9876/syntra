import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { DeleteObjectsCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createBackupEncryptor, MIN_PASSPHRASE_LENGTH, type BackupManifest } from '@syntra/core';

/**
 * Off-site copies: each backup, encrypted the way a download is, in an
 * S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO, ...).
 *
 * The file in the bucket is a `.syntra-backup`: the same format and the same
 * passphrase rule as Administration -> Backups -> Download. Recovering from it
 * on a new server is an Upload in the console with BACKUP_S3_PASSPHRASE.
 *
 * Settings come from the agent's environment, not the database. Credentials
 * stored in the database would sit inside the very backups being copied, and
 * restoring an old one would bring old keys back.
 *
 *   BACKUP_S3_BUCKET               turns it on
 *   BACKUP_S3_PASSPHRASE           required; at least 12 characters
 *   BACKUP_S3_REGION               default us-east-1
 *   BACKUP_S3_ENDPOINT             for anything that is not AWS
 *   BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY
 *                                  unset: the AWS default chain (IAM role, IRSA)
 *   BACKUP_S3_PREFIX               default `syntra/`
 *   BACKUP_S3_FORCE_PATH_STYLE     default true when an endpoint is set
 */
export interface OffsiteConfig {
  bucket: string;
  passphrase: string;
  region: string;
  endpoint: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  prefix: string;
  forcePathStyle: boolean;
}

export function offsiteConfigFrom(env: Record<string, string | undefined>): OffsiteConfig | null {
  const value = (name: string) => env[name]?.trim() || null;
  const bucket = value('BACKUP_S3_BUCKET');
  if (!bucket) return null;
  const passphrase = env['BACKUP_S3_PASSPHRASE'] ?? '';
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`BACKUP_S3_PASSPHRASE must be at least ${MIN_PASSPHRASE_LENGTH} characters when BACKUP_S3_BUCKET is set`);
  }
  const accessKeyId = value('BACKUP_S3_ACCESS_KEY_ID');
  const secretAccessKey = value('BACKUP_S3_SECRET_ACCESS_KEY');
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error('Set both BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY, or neither');
  }
  const endpoint = value('BACKUP_S3_ENDPOINT');
  const prefix = value('BACKUP_S3_PREFIX') ?? 'syntra/';
  const pathStyle = value('BACKUP_S3_FORCE_PATH_STYLE');
  return {
    bucket,
    passphrase,
    region: value('BACKUP_S3_REGION') ?? 'us-east-1',
    endpoint,
    accessKeyId,
    secretAccessKey,
    prefix: prefix.endsWith('/') || prefix === '' ? prefix : `${prefix}/`,
    forcePathStyle: pathStyle === null ? endpoint !== null : pathStyle === 'true',
  };
}

export interface Offsite {
  /** Where copies go, for the console; never the credentials. */
  describe(): { bucket: string; endpoint: string | null; prefix: string };
  keyFor(name: string): string;
  /** Encrypts the backup and uploads it. */
  upload(name: string, manifest: BackupManifest, dumpFile: string): Promise<void>;
  /** Deletes the copies of backups local retention removed. */
  remove(names: string[]): Promise<void>;
  /** Writes and deletes a small object, to prove the settings work. */
  test(): Promise<void>;
}

export function s3Offsite(config: OffsiteConfig, client?: S3Client): Offsite {
  const s3 =
    client ??
    new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.accessKeyId && config.secretAccessKey
        ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
        : {}),
    });
  const keyFor = (name: string) => `${config.prefix}${name}.syntra-backup`;

  return {
    describe: () => ({ bucket: config.bucket, endpoint: config.endpoint, prefix: config.prefix }),
    keyFor,

    async upload(name, manifest, dumpFile) {
      const encryptor = await createBackupEncryptor(config.passphrase, manifest);
      const body = new PassThrough();
      const encrypting = pipeline(createReadStream(dumpFile), encryptor, body);
      const upload = new Upload({
        client: s3,
        params: {
          Bucket: config.bucket,
          Key: keyFor(name),
          Body: body,
          ContentType: 'application/octet-stream',
        },
      });
      await Promise.all([encrypting, upload.done()]);
    },

    async remove(names) {
      if (names.length === 0) return;
      for (let i = 0; i < names.length; i += 1000) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: names.slice(i, i + 1000).map((name) => ({ Key: keyFor(name) })), Quiet: true },
          }),
        );
      }
    },

    async test() {
      const Key = `${config.prefix}.syntra-write-test`;
      await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key, Body: 'syntra' }));
      await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key }));
    },
  };
}
