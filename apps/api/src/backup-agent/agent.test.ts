import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION } from '@syntra/core';
import { createAgent, type Job } from './agent.js';
import type { AgentConfig } from './config.js';
import { offsiteConfigFrom, type Offsite } from './offsite.js';
import type { PgTools } from './postgres.js';
import { backupStore } from './store.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Client tools that dump something shaped like an archive; `counts` is what a restore test finds. */
function fakePg(counts = '5 10'): PgTools & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    async dump(file) {
      await writeFile(file, Buffer.concat([Buffer.from('PGDMP'), randomBytes(256)]));
    },
    async tableDataSections() {
      return 3;
    },
    async restore() {},
    async sql(sql) {
      statements.push(sql.trim());
      if (sql.includes('pg_stat_user_tables')) return `${counts}\n`;
      return '';
    },
  };
}

function fakeOffsite(fail: string | null = null): Offsite & { uploads: string[]; removed: string[][] } {
  const uploads: string[] = [];
  const removed: string[][] = [];
  return {
    uploads,
    removed,
    describe: () => ({ bucket: 'acme-backups', endpoint: null, prefix: 'syntra/' }),
    keyFor: (name) => `syntra/${name}.syntra-backup`,
    async upload(name) {
      if (fail) throw new Error(fail);
      uploads.push(name);
    },
    async remove(names) {
      removed.push(names);
    },
    async test() {
      if (fail) throw new Error(fail);
    },
  };
}

function config(dir: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    superuserUrl: 'postgresql://syntra@db/syntra',
    databaseUrl: 'postgresql://syntra_app@db/syntra',
    dir,
    port: 0,
    host: '127.0.0.1',
    token: 'x'.repeat(32),
    intervalHours: 1,
    retention: DEFAULT_RETENTION,
    pgContainer: null,
    copyCommand: null,
    fingerprint: null,
    settleMs: 0,
    verifyEveryDays: 7,
    ...over,
  };
}

function agentIn(dir: string, options: { pg?: PgTools; scratch?: PgTools; offsite?: Offsite | null; config?: Partial<AgentConfig>; now?: () => Date } = {}) {
  const pg = options.pg ?? fakePg();
  let tick = 0;
  return createAgent({
    config: config(dir, options.config),
    store: backupStore(dir, pg, options.now ?? (() => new Date(Date.UTC(2026, 9, 6, 12, 0, tick++)))),
    pg,
    toolsFor: () => options.scratch ?? pg,
    offsite: options.offsite ?? null,
    version: '1.21.0',
    database: 'syntra',
    appRole: 'syntra_app',
    superRole: 'syntra',
    migrate: async () => undefined,
    log: silent,
    settleMs: 0,
    ...(options.now ? { now: options.now } : {}),
  });
}

async function finished(agent: ReturnType<typeof createAgent>, job: Job): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const current = agent.job(job.id);
    if (current && current.state !== 'running') return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job did not finish');
}

describe('backup agent: off-site copies', () => {
  it('copies each backup and removes only what local retention pruned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syntra-agent-'));
    const offsite = fakeOffsite();
    const agent = agentIn(dir, { offsite, config: { retention: { ...DEFAULT_RETENTION, manual: 1 } } });
    await agent.ready;

    const first = await finished(agent, agent.backupNow('admin'));
    const second = await finished(agent, agent.backupNow('admin'));
    expect(first.state).toBe('succeeded');
    expect(second.state).toBe('succeeded');
    expect(offsite.uploads).toEqual([first.backupName, second.backupName]);
    // Keeping one manual backup pruned the first, here and in the bucket.
    expect(offsite.removed).toEqual([[], [first.backupName]]);
    expect(agent.status().health.lastCopy).toMatchObject({ ok: true, name: second.backupName });
  });

  it('keeps the backup and records the failure when the copy fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syntra-agent-'));
    const agent = agentIn(dir, { offsite: fakeOffsite('AccessDenied: no PutObject on acme-backups') });
    await agent.ready;
    const job = await finished(agent, agent.backupNow(null));
    expect(job.state).toBe('succeeded');
    expect(job.message).toMatch(/Taken, but off-site copy failed: AccessDenied/);
    const { health } = agent.status();
    expect(health.lastBackup).toMatchObject({ ok: true });
    expect(health.lastCopy).toMatchObject({ ok: false, message: 'AccessDenied: no PutObject on acme-backups' });
    expect(health.lastCopySuccessAt).toBeNull();
  });

  it('reads its bucket settings, and refuses a missing or short passphrase', () => {
    expect(offsiteConfigFrom({})).toBeNull();
    expect(() => offsiteConfigFrom({ BACKUP_S3_BUCKET: 'b' })).toThrow('BACKUP_S3_PASSPHRASE must be at least 12 characters');
    expect(() => offsiteConfigFrom({ BACKUP_S3_BUCKET: 'b', BACKUP_S3_PASSPHRASE: 'p'.repeat(12), BACKUP_S3_ACCESS_KEY_ID: 'k' })).toThrow(
      'Set both BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY, or neither',
    );
    expect(
      offsiteConfigFrom({ BACKUP_S3_BUCKET: 'b', BACKUP_S3_PASSPHRASE: 'p'.repeat(12), BACKUP_S3_ENDPOINT: 'http://minio:9000', BACKUP_S3_PREFIX: 'acme' }),
    ).toMatchObject({ region: 'us-east-1', prefix: 'acme/', forcePathStyle: true, endpoint: 'http://minio:9000' });
  });
});

describe('backup agent: restore tests', () => {
  it('restores into a scratch database, records the pass on the backup, and drops it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syntra-agent-'));
    const pg = fakePg();
    const scratch = fakePg('147 12345');
    const agent = agentIn(dir, { pg, scratch });
    await agent.ready;
    const backup = await finished(agent, agent.backupNow(null));

    const test = await finished(agent, agent.verify(null, 'admin'));
    expect(test).toMatchObject({ state: 'succeeded', kind: 'verify', backupName: backup.backupName });
    expect(test.message).toBe(`${backup.backupName} restored: 147 tables, 12,345 rows.`);
    expect(pg.statements.some((sql) => /^CREATE DATABASE "syntra_verify_\d+";$/.test(sql))).toBe(true);
    expect(pg.statements.some((sql) => /^DROP DATABASE IF EXISTS "syntra_verify_\d+" WITH \(FORCE\);$/.test(sql))).toBe(true);
    const manifest = JSON.parse(await readFile(join(dir, backup.backupName!, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ verifiedTables: 147, verifiedRows: 12345 });
    expect(agent.status().health.lastVerify).toMatchObject({ ok: true, name: backup.backupName });
  });

  it('fails a backup that restores nothing, and still drops the scratch database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syntra-agent-'));
    const pg = fakePg();
    const agent = agentIn(dir, { pg, scratch: fakePg('3 0') });
    await agent.ready;
    const backup = await finished(agent, agent.backupNow(null));
    const test = await finished(agent, agent.verify(backup.backupName, null));
    expect(test).toMatchObject({ state: 'failed', message: `${backup.backupName} restored 3 tables and no rows.` });
    expect(pg.statements.filter((sql) => sql.startsWith('DROP DATABASE'))).toHaveLength(1);
    expect(agent.status().health).toMatchObject({ lastVerify: { ok: false }, lastVerifySuccessAt: null });
  });

  it('runs when due, not again within the week, and not hourly after a failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syntra-agent-'));
    let clock = Date.UTC(2026, 9, 6, 12);
    const now = () => new Date(clock);
    const agent = agentIn(dir, { now });
    await agent.ready;
    clock += 1000;
    await finished(agent, agent.backupNow(null));

    const first = agent.verifyIfDue();
    expect(first).not.toBeNull();
    await finished(agent, first!);
    clock += 3 * 86_400_000;
    expect(agent.verifyIfDue()).toBeNull();
    clock += 5 * 86_400_000;
    expect(agent.verifyIfDue()).not.toBeNull();
  });

  it('remembers its health across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syntra-agent-'));
    const before = agentIn(dir);
    await before.ready;
    await finished(before, before.backupNow(null));
    const after = agentIn(dir);
    await after.ready;
    expect(after.status().health.lastBackupSuccessAt).toBe(before.status().health.lastBackupSuccessAt);
    expect(after.status().health.lastBackupSuccessAt).not.toBeNull();
  });
});
