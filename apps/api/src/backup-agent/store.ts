import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_NAME,
  backupManifest,
  backupNameFor,
  pointsToPrune,
  type BackupKind,
  type BackupManifest,
  type RetentionPolicy,
} from '@syntra/core';
import type { PgTools } from './postgres.js';

/**
 * Backups on disk, in the layout `ops/syntra-backup` writes:
 *
 *   <dir>/syntra-20261005T020000Z/database.dump
 *   <dir>/syntra-20261005T020000Z/manifest.json
 *
 * A backup is written into `<name>.partial` and renamed into place only once
 * every check has passed, so an interrupted one is never mistaken for a
 * backup. Files are 0600: a dump is every tenant's data.
 */
export interface StoredBackup extends BackupManifest {
  name: string;
}

export class BackupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRefusedError';
  }
}

export interface BackupStore {
  dir: string;
  list(): Promise<StoredBackup[]>;
  get(name: string): Promise<StoredBackup | null>;
  dumpPath(name: string): string;
  create(kind: BackupKind, context: { version: string; fingerprint: string | null; database: string }): Promise<StoredBackup>;
  importUpload(manifest: BackupManifest, dump: Readable): Promise<StoredBackup>;
  remove(name: string): Promise<void>;
  prune(policy: RetentionPolicy): Promise<string[]>;
}

const PGDMP = Buffer.from('PGDMP', 'ascii');

async function startsWithPgdmp(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(5);
    const { bytesRead } = await handle.read(head, 0, 5, 0);
    return bytesRead === 5 && head.equals(PGDMP);
  } finally {
    await handle.close();
  }
}

export function backupStore(dir: string, pg: PgTools, now: () => Date = () => new Date()): BackupStore {
  const pathOf = (name: string) => {
    if (!BACKUP_NAME.test(name)) throw new BackupRefusedError(`Not a backup name: ${name}`);
    return join(dir, name);
  };

  async function read(name: string): Promise<StoredBackup | null> {
    try {
      const raw = JSON.parse(await readFile(join(pathOf(name), 'manifest.json'), 'utf8')) as unknown;
      const manifest = backupManifest.safeParse(raw);
      return manifest.success ? { name, ...manifest.data } : null;
    } catch {
      return null;
    }
  }

  /** A fresh `.partial` directory for a backup named after `at`. */
  async function partialFor(at: Date, suffix?: string): Promise<{ name: string; partial: string }> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = backupNameFor(at, suffix);
    const partial = join(dir, `${name}.partial`);
    try {
      await stat(join(dir, name));
      throw new BackupRefusedError(`${name} already exists`);
    } catch (err) {
      if (err instanceof BackupRefusedError) throw err;
    }
    await mkdir(partial, { mode: 0o700 });
    return { name, partial };
  }

  /** The checks a dump passes before it is a backup, as ops/syntra-backup makes them. */
  async function check(file: string): Promise<{ sections: number; bytes: number }> {
    const { size } = await stat(file);
    if (size === 0) throw new BackupRefusedError('The dump is empty.');
    if (!(await startsWithPgdmp(file))) throw new BackupRefusedError('The dump is not a PostgreSQL archive.');
    const sections = await pg.tableDataSections(file);
    if (sections === 0) {
      throw new BackupRefusedError(
        'The dump contains no table data. Was it taken as a role that bypasses row-level security?',
      );
    }
    return { sections, bytes: size };
  }

  async function seal(partial: string, name: string, manifest: BackupManifest): Promise<StoredBackup> {
    await writeFile(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(partial, join(dir, name));
    return { name, ...manifest };
  }

  return {
    dir,

    async list() {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }
      const backups = await Promise.all(entries.filter((entry) => BACKUP_NAME.test(entry)).map(read));
      return backups
        .filter((backup): backup is StoredBackup => backup !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
    },

    get: read,

    dumpPath(name) {
      return join(pathOf(name), 'database.dump');
    },

    async create(kind, context) {
      const at = now();
      // `-before`, not `-pre-restore`: a name of 32 characters or more with
      // digits and both cases is what the log scrubber takes for a credential.
      const { name, partial } = await partialFor(at, kind === 'pre-restore' ? 'before' : undefined);
      try {
        const file = join(partial, 'database.dump');
        // Created 0600 before anything is written to it.
        await writeFile(file, '', { mode: 0o600 });
        await pg.dump(file);
        const { sections, bytes } = await check(file);
        return await seal(partial, name, {
          createdAt: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          version: context.version,
          database: context.database,
          tableDataSections: sections,
          bytes,
          masterKeyFingerprint: context.fingerprint,
          kind,
        });
      } catch (err) {
        await rm(partial, { recursive: true, force: true });
        throw err;
      }
    },

    async importUpload(manifest, dump) {
      const { name, partial } = await partialFor(now(), 'upload');
      try {
        const file = join(partial, 'database.dump');
        await pipeline(dump, createWriteStream(file, { mode: 0o600 }));
        await chmod(file, 0o600);
        const { sections, bytes } = await check(file);
        return await seal(partial, name, { ...manifest, tableDataSections: sections, bytes, kind: 'uploaded' });
      } catch (err) {
        await rm(partial, { recursive: true, force: true });
        throw err;
      }
    },

    async remove(name) {
      await rm(pathOf(name), { recursive: true, force: true });
    },

    async prune(policy) {
      const backups = await this.list();
      const doomed = pointsToPrune(
        backups.map((backup) => ({ name: backup.name, takenAt: new Date(backup.createdAt), kind: backup.kind })),
        policy,
      );
      for (const name of doomed) await rm(pathOf(name), { recursive: true, force: true });
      return doomed;
    },
  };
}

/** A read stream of a backup's dump, for a download. */
export function dumpStream(store: BackupStore, name: string): Readable {
  return createReadStream(store.dumpPath(name));
}
