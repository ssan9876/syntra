import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { BackupHealth, BackupManifest, RetentionPolicy } from '@syntra/core';
import type { Job } from './agent.js';
import type { StoredBackup } from './store.js';

export interface AgentStatus {
  version: string;
  startedAt: string;
  health: BackupHealth;
  verifyEveryDays: number;
  offsite: { bucket: string; endpoint: string | null; prefix: string } | null;
  intervalHours: number;
  /** When the console last set the schedule; null while BACKUP_INTERVAL_HOURS applies. */
  intervalSetAt: string | null;
  retention: RetentionPolicy;
  fingerprint: string | null;
  copyConfigured: boolean;
  current: Job | null;
  recent: Job[];
  lastScheduledAt: string | null;
}

/** The agent answered, with a refusal the console can show as it is. */
export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** The agent did not answer at all. */
export class AgentUnreachableError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(`Backup service at ${url} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'AgentUnreachableError';
  }
}

/** The API's side of apps/api/src/backup-agent/http.ts. */
export function backupAgentClient(agent: { url: string; token: string }) {
  async function call(path: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${agent.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${agent.token}`, ...(init.headers ?? {}) },
      });
    } catch (cause) {
      throw new AgentUnreachableError(agent.url, cause);
    }
    if (response.ok) return response;
    let body: { error?: string; message?: string } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Not JSON: the status says enough.
    }
    throw new AgentError(response.status, body.error ?? 'error', body.message ?? `Backup service answered ${response.status}.`);
  }

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => (await (await call(path, init)).json()) as T;
  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    /** Three seconds at most: an incident list or a scrape must not wait on a dead agent. */
    status: () => json<AgentStatus>('/v1/status', { signal: AbortSignal.timeout(3_000) }),
    setSchedule: async (intervalHours: number, requestedBy: string) =>
      (
        await json<{ intervalHours: number }>('/v1/schedule', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ intervalHours, requestedBy }),
        })
      ).intervalHours,
    list: async () => (await json<{ backups: StoredBackup[] }>('/v1/backups')).backups,
    backupNow: async (requestedBy: string) => (await json<{ job: Job }>('/v1/backups', post({ requestedBy }))).job,
    restore: async (name: string, requestedBy: string) =>
      (await json<{ job: Job }>('/v1/restores', post({ name, requestedBy }))).job,
    verify: async (name: string | null, requestedBy: string) =>
      (await json<{ job: Job }>('/v1/verifies', post({ name, requestedBy }))).job,
    testOffsite: async () => {
      await call('/v1/offsite/test', { method: 'POST' });
    },
    job: async (id: string) => (await json<{ job: Job }>(`/v1/jobs/${encodeURIComponent(id)}`)).job,
    remove: async (name: string) => {
      await call(`/v1/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
    },
    /** The dump, streamed. */
    dump: async (name: string): Promise<Readable> => {
      const response = await call(`/v1/backups/${encodeURIComponent(name)}/dump`);
      return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    },
    /** Hands a decrypted dump to the agent, which checks it and stores it as an uploaded backup. */
    upload: async (manifest: BackupManifest, dump: Readable): Promise<StoredBackup> => {
      const response = await call('/v1/uploads', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-syntra-manifest': Buffer.from(JSON.stringify(manifest)).toString('base64'),
        },
        body: Readable.toWeb(dump) as unknown as BodyInit,
        duplex: 'half',
      });
      return ((await response.json()) as { backup: StoredBackup }).backup;
    },
  };
}

export type BackupAgentClient = ReturnType<typeof backupAgentClient>;

/** The agent's status for a metrics scrape, or null when it did not answer. */
export function backupStatusReader(agent: { url: string; token: string }): () => Promise<AgentStatus | null> {
  const client = backupAgentClient(agent);
  return () => client.status().catch(() => null);
}
