import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { BackupKind, BackupManifest } from '@syntra/core';
import type { AgentConfig } from './config.js';
import type { PgTools } from './postgres.js';
import { restoreBackup, type RestoreOutcome } from './restore.js';
import { BackupRefusedError, type BackupStore, type StoredBackup } from './store.js';

export type JobKind = 'backup' | 'restore';
export type JobState = 'running' | 'succeeded' | 'failed';

export interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  /** What it is doing now, or did last. */
  step: string;
  /** The outcome, once finished. */
  message: string | null;
  backupName: string | null;
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export class AgentBusyError extends Error {
  constructor(readonly job: Job) {
    super(`A ${job.kind} is already running: ${job.step}`);
    this.name = 'AgentBusyError';
  }
}

export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface AgentDeps {
  config: AgentConfig;
  store: BackupStore;
  pg: PgTools;
  version: string;
  database: string;
  appRole: string;
  superRole: string;
  migrate(): Promise<void>;
  log: Logger;
  now?(): Date;
  settleMs?: number;
}

const HISTORY = 20;

/**
 * One thing at a time: a backup, a restore or an upload. A scheduled backup
 * that finds the agent busy is skipped, not queued -- the next one is an hour
 * away, and a backup taken mid-restore would be of a database being replaced.
 */
export function createAgent(deps: AgentDeps) {
  const now = deps.now ?? (() => new Date());
  const historyFile = join(deps.config.dir, 'jobs.json');
  let current: Job | null = null;
  let history: Job[] = [];
  let busy = false;
  let lastScheduledAt: Date | null = null;

  const loaded = readFile(historyFile, 'utf8')
    .then((raw) => {
      const jobs = JSON.parse(raw) as Job[];
      // A job recorded as running is one this process did not finish: it died.
      history = jobs.map((job) =>
        job.state === 'running'
          ? { ...job, state: 'failed', message: `Interrupted at "${job.step}".`, finishedAt: job.finishedAt ?? job.startedAt }
          : job,
      );
    })
    .catch(() => undefined);

  async function persist(): Promise<void> {
    const jobs = current ? [current, ...history] : history;
    await writeFile(historyFile, JSON.stringify(jobs.slice(0, HISTORY), null, 2), { mode: 0o600 }).catch(
      (err: unknown) => deps.log.warn({ err: String(err) }, 'backup job history not written'),
    );
  }

  function claim(): void {
    if (busy) throw new AgentBusyError(current ?? fallbackJob());
    busy = true;
  }

  function fallbackJob(): Job {
    return {
      id: 'upload', kind: 'backup', state: 'running', step: 'Receiving an upload', message: null,
      backupName: null, requestedBy: null, startedAt: now().toISOString(), finishedAt: null,
    };
  }

  function start(kind: JobKind, requestedBy: string | null, backupName: string | null, run: (job: Job) => Promise<string>): Job {
    claim();
    const job: Job = {
      id: randomUUID(), kind, state: 'running', step: 'Starting', message: null,
      backupName, requestedBy, startedAt: now().toISOString(), finishedAt: null,
    };
    current = job;
    void persist();
    void (async () => {
      try {
        job.message = await run(job);
        job.state = 'succeeded';
        deps.log.info({ jobId: job.id, kind, backupName: job.backupName }, `${kind} succeeded: ${job.message}`);
      } catch (err) {
        job.state = 'failed';
        job.message = err instanceof Error ? err.message : String(err);
        deps.log.error({ jobId: job.id, kind, backupName: job.backupName }, `${kind} failed: ${job.message}`);
      } finally {
        job.finishedAt = now().toISOString();
        history = [job, ...history].slice(0, HISTORY);
        current = null;
        busy = false;
        await persist();
      }
    })();
    return job;
  }

  async function copyOffHost(backup: StoredBackup): Promise<void> {
    const command = deps.config.copyCommand;
    if (!command) return;
    const dir = join(deps.config.dir, backup.name);
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command, 'syntra-backup-copy', dir], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { PATH: process.env['PATH'], HOME: process.env['HOME'], SYNTRA_BACKUP_PATH: dir, SYNTRA_BACKUP_NAME: backup.name },
      });
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    if (code !== 0) {
      throw new Error(`Copy of ${backup.name} failed: BACKUP_COPY_COMMAND exited ${code ?? 'abnormally'}. The backup is kept.`);
    }
  }

  async function takeBackup(kind: BackupKind, job: Job): Promise<string> {
    job.step = 'Dumping the database';
    void persist();
    const backup = await deps.store.create(kind, {
      version: deps.version,
      fingerprint: deps.config.fingerprint,
      database: deps.database,
    });
    job.backupName = backup.name;
    job.step = 'Pruning old restore points';
    const pruned = await deps.store.prune(deps.config.retention);
    if (pruned.length) deps.log.info({ pruned }, `pruned ${pruned.length} restore point(s)`);
    job.step = 'Copying off this host';
    await copyOffHost(backup);
    return `${backup.name}: ${backup.bytes.toLocaleString('en')} bytes, ${backup.tableDataSections} tables.`;
  }

  return {
    ready: loaded,

    status() {
      return {
        version: deps.version,
        intervalHours: deps.config.intervalHours,
        retention: deps.config.retention,
        fingerprint: deps.config.fingerprint,
        copyConfigured: deps.config.copyCommand !== null,
        current,
        recent: history.slice(0, 10),
        lastScheduledAt: lastScheduledAt?.toISOString() ?? null,
      };
    },

    job(id: string): Job | null {
      if (current?.id === id) return current;
      return history.find((job) => job.id === id) ?? null;
    },

    backupNow(requestedBy: string | null): Job {
      return start('backup', requestedBy, null, (job) => takeBackup('manual', job));
    },

    /** Called on the schedule. Busy is a skip, logged, not an error. */
    scheduled(): Job | null {
      lastScheduledAt = now();
      if (busy) {
        deps.log.warn({ current: current?.id ?? null }, 'scheduled backup skipped: another job is running');
        return null;
      }
      return start('backup', null, null, (job) => takeBackup('scheduled', job));
    },

    restore(name: string, requestedBy: string | null): Job {
      return start('restore', requestedBy, name, async (job) => {
        const outcome: RestoreOutcome = await restoreBackup(name, {
          pg: deps.pg,
          store: deps.store,
          appRole: deps.appRole,
          superRole: deps.superRole,
          version: deps.version,
          fingerprint: deps.config.fingerprint,
          database: deps.database,
          migrate: deps.migrate,
          ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}),
          step(message) {
            job.step = message;
            deps.log.info({ jobId: job.id, backupName: name }, `restore: ${message}`);
            void persist();
          },
        });
        if (outcome.rolledBack) throw new BackupRefusedError(outcome.message);
        return outcome.safety
          ? `${outcome.message} The state before it is kept as ${outcome.safety}.`
          : outcome.message;
      });
    },

    /** Receives an uploaded backup. Holds the agent for its duration. */
    async upload(manifest: BackupManifest, dump: Readable): Promise<StoredBackup> {
      claim();
      try {
        return await deps.store.importUpload(manifest, dump);
      } finally {
        busy = false;
      }
    },

    async remove(name: string): Promise<void> {
      if (current?.backupName === name) throw new AgentBusyError(current);
      await deps.store.remove(name);
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
