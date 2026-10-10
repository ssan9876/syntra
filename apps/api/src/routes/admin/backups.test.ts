import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  assignRole,
  createBackupDecryptor,
  createRole,
  createSession,
  createUser,
  DEFAULT_RETENTION,
  keyFingerprint,
  PERMISSIONS,
  type Permission,
} from '@syntra/core';
import { buildTestApp, createFakeScheduler } from '../../test-support.js';
import { createAgent } from '../../backup-agent/agent.js';
import { agentServer } from '../../backup-agent/http.js';
import type { PgTools } from '../../backup-agent/postgres.js';
import { backupStore } from '../../backup-agent/store.js';
import type { Offsite } from '../../backup-agent/offsite.js';

const TOKEN = 'test-backup-agent-token-0123456789abcdef';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Client tools that write something shaped like a dump and restore nothing. */
const fakePg: PgTools = {
  async dump(file) {
    await writeFile(file, Buffer.concat([Buffer.from('PGDMP'), randomBytes(4096)]));
  },
  async tableDataSections() {
    return 3;
  },
  async restore() {},
  async sql(statements) {
    if (statements.includes('pg_terminate_backend')) return '0\n';
    if (statements.includes('pg_stat_user_tables')) return '5 10\n';
    return '';
  },
};

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let server: Server | null = null;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'syntra-backups-'));
});

afterEach(async () => {
  await ctx?.app.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function startAgent(offsite: Offsite | null = null): Promise<string> {
  const store = backupStore(dir, fakePg);
  const agent = createAgent({
    config: {
      superuserUrl: 'postgresql://syntra@db/syntra',
      databaseUrl: 'postgresql://syntra_app@db/syntra',
      dir,
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      intervalHours: 0,
      retention: DEFAULT_RETENTION,
      pgContainer: null,
      copyCommand: null,
      fingerprint: keyFingerprint(process.env),
      settleMs: 0,
      verifyEveryDays: 0,
    },
    store,
    pg: fakePg,
    version: 'dev',
    database: 'syntra',
    appRole: 'syntra_app',
    superRole: 'syntra',
    migrate: async () => undefined,
    toolsFor: () => fakePg,
    offsite,
    log: silent,
    settleMs: 0,
  });
  await agent.ready;
  server = agentServer(agent, store, TOKEN);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function cookieFor(login: string, permissions: Permission[]): Promise<string> {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id);
    const session = await createSession(tx, {
      status: 'allow', userId: user.id, mayElevate: true,
      scope: 'admin', applicationId: null, satisfiedFactor: null,
    }, { ip: null, userAgent: null });
    return `syntra_session=${session.token}`;
  });
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

async function settle(cookie: string, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { job } = (await call('GET', `/api/admin/backups/jobs/${id}`, cookie)).json() as { job: { state: string; message: string } };
    if (job.state !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

async function decrypt(file: Buffer, passphrase: string) {
  const decryptor = createBackupDecryptor(passphrase);
  const parts: Buffer[] = [];
  decryptor.on('data', (chunk: Buffer) => parts.push(chunk));
  await pipeline(Readable.from([file]), decryptor);
  return { manifest: await decryptor.manifest, dump: Buffer.concat(parts) };
}

describe('backup routes', () => {
  it('say no backup service is configured when BACKUP_AGENT_URL is unset', async () => {
    ctx = await buildTestApp({ scheduler: () => createFakeScheduler() });
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE]);
    expect((await call('GET', '/api/admin/backups', operator)).json()).toMatchObject({ configured: false, backups: [] });
    const refused = await call('POST', '/api/admin/backups', operator, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toBe('BACKUP_AGENT_URL is not set.');
  });

  it('take, list, download, upload, restore and delete, and only for deployment.manage', async () => {
    const url = await startAgent();
    ctx = await buildTestApp({
      scheduler: () => createFakeScheduler(),
      env: { BACKUP_AGENT_URL: url, BACKUP_AGENT_TOKEN: TOKEN },
    });
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE]);
    const tenantAdmin = await cookieFor('tenant-admin', [PERMISSIONS.TENANT_MANAGE]);

    expect((await call('GET', '/api/admin/backups', tenantAdmin)).statusCode).toBe(403);

    // Back up now.
    const started = await call('POST', '/api/admin/backups', operator, {});
    expect(started.statusCode).toBe(202);
    expect((await settle(operator, started.json().job.id)).state).toBe('succeeded');
    const listed = (await call('GET', '/api/admin/backups', operator)).json();
    expect(listed.configured).toBe(true);
    expect(listed.backups).toHaveLength(1);
    const backup = listed.backups[0];
    expect(backup).toMatchObject({ kind: 'manual', versionCheck: 'unknown' });
    expect(backup.key).toBe(keyFingerprint(process.env) ? 'match' : 'unknown');

    // Download: a passphrase is required, and the file decrypts to the dump.
    expect((await call('POST', `/api/admin/backups/${backup.name}/download`, operator, { passphrase: 'short' })).statusCode).toBe(400);
    const download = await call('POST', `/api/admin/backups/${backup.name}/download`, operator, {
      passphrase: 'correct horse battery staple',
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${backup.name}.syntra-backup"`);
    const file = download.rawPayload;
    const opened = await decrypt(file, 'correct horse battery staple');
    expect(opened.dump.subarray(0, 5).toString()).toBe('PGDMP');
    expect(opened.manifest).toMatchObject({ createdAt: backup.createdAt, kind: 'manual' });

    // Upload: the wrong passphrase is refused by name; the right one stores it.
    const upload = (passphrase: string, payload: Buffer) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/admin/backups/upload',
        headers: {
          host: ctx.host,
          cookie: operator,
          'content-type': 'application/octet-stream',
          'x-backup-passphrase': passphrase,
        },
        payload,
      });
    const wrong = await upload('a different passphrase', file);
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().type).toMatch(/backup-wrong-passphrase$/);
    const truncated = await upload('correct horse battery staple', file.subarray(0, file.length - 20));
    expect(truncated.statusCode).toBe(422);
    const uploaded = await upload('correct horse battery staple', file);
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().backup).toMatchObject({ kind: 'uploaded', createdAt: backup.createdAt });

    // Restore: the name must be typed again, and a different key is refused.
    const restorePath = `/api/admin/backups/${backup.name}/restore`;
    expect((await call('POST', restorePath, operator, { confirm: 'something else' })).statusCode).toBe(400);
    const foreign = 'syntra-20200101T000000Z';
    await mkdir(join(dir, foreign));
    await writeFile(join(dir, foreign, 'database.dump'), 'PGDMP');
    await writeFile(
      join(dir, foreign, 'manifest.json'),
      JSON.stringify({ createdAt: '2020-01-01T00:00:00Z', version: '1.0.0', tableDataSections: 1, bytes: 5, masterKeyFingerprint: 'sha256:other', kind: 'manual' }),
    );
    if (keyFingerprint(process.env)) {
      const mismatch = await call('POST', `/api/admin/backups/${foreign}/restore`, operator, { confirm: foreign });
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json().type).toMatch(/key-mismatch$/);
    }
    const restore = await call('POST', restorePath, operator, { confirm: backup.name });
    expect(restore.statusCode).toBe(202);
    const restored = await settle(operator, restore.json().job.id);
    expect(restored).toMatchObject({ state: 'succeeded' });
    expect(restored.message).toMatch(new RegExp(`^Restored ${backup.name}\\. The state before it is kept as syntra-\\d{8}T\\d{6}Z-before\\.$`));

    // Delete.
    expect((await call('DELETE', `/api/admin/backups/${foreign}`, operator)).statusCode).toBe(204);
    const names = (await call('GET', '/api/admin/backups', operator)).json().backups.map((b: { name: string }) => b.name);
    expect(names).not.toContain(foreign);

    const actions = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'deployment.' } }, orderBy: { sequence: 'asc' } }));
    expect(actions.map((event) => event.action)).toEqual([
      'deployment.backup_requested',
      'deployment.backup_downloaded',
      'deployment.backup_uploaded',
      'deployment.restore_requested',
      'deployment.backup_deleted',
    ]);
  });

  it('set the restore point schedule, only to an offered interval, and record it', async () => {
    const url = await startAgent();
    ctx = await buildTestApp({
      scheduler: () => createFakeScheduler(),
      env: { BACKUP_AGENT_URL: url, BACKUP_AGENT_TOKEN: TOKEN },
    });
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE]);
    const tenantAdmin = await cookieFor('tenant-admin', [PERMISSIONS.TENANT_MANAGE]);

    expect((await call('PUT', '/api/admin/backups/schedule', tenantAdmin, { intervalHours: 6 })).statusCode).toBe(403);
    expect((await call('PUT', '/api/admin/backups/schedule', operator, { intervalHours: 5 })).statusCode).toBe(400);

    const set = await call('PUT', '/api/admin/backups/schedule', operator, { intervalHours: 6 });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ intervalHours: 6 });
    const { status } = (await call('GET', '/api/admin/backups', operator)).json();
    expect(status.intervalHours).toBe(6);
    expect(status.intervalSetAt).toEqual(expect.any(String));

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'deployment.backup_schedule_changed' } }));
    expect(events.map((event) => event.payload)).toEqual([{ from: 0, to: 6 }]);
  });

  it('lists failing backups as an incident to deployment.manage, and tests the bucket', async () => {
    const failing: Offsite = {
      describe: () => ({ bucket: 'acme-backups', endpoint: null, prefix: 'syntra/' }),
      keyFor: (name) => name,
      upload: async () => {
        throw new Error('AccessDenied');
      },
      remove: async () => undefined,
      test: async () => {
        throw new Error('AccessDenied');
      },
    };
    const url = await startAgent(failing);
    ctx = await buildTestApp({
      scheduler: () => createFakeScheduler(),
      env: { BACKUP_AGENT_URL: url, BACKUP_AGENT_TOKEN: TOKEN },
    });
    const operator = await cookieFor('operator', [PERMISSIONS.DEPLOYMENT_MANAGE, PERMISSIONS.AUDIT_READ]);
    const auditor = await cookieFor('auditor', [PERMISSIONS.AUDIT_READ]);

    const started = await call('POST', '/api/admin/backups', operator, {});
    expect((await settle(operator, started.json().job.id)).state).toBe('succeeded');

    const kinds = async (cookie: string) =>
      ((await call('GET', '/api/admin/incidents', cookie)).json() as { incidents: { kind: string; items: { detail: string }[] }[] }).incidents;
    const seen = (await kinds(operator)).find((incident) => incident.kind === 'backups_failing');
    expect(seen?.items.map((item) => item.detail)).toEqual([expect.stringMatching(/^Failed at .* UTC: AccessDenied$/)]);
    expect((await kinds(auditor)).some((incident) => incident.kind === 'backups_failing')).toBe(false);

    const bucket = await call('POST', '/api/admin/backups/offsite/test', operator, {});
    expect(bucket.statusCode).toBe(422);
    expect(bucket.json().detail).toBe('acme-backups: AccessDenied');

    const name = (await call('GET', '/api/admin/backups', operator)).json().backups[0].name;
    const test = await call('POST', `/api/admin/backups/${name}/verify`, operator, {});
    expect(test.statusCode).toBe(202);
    expect(await settle(operator, test.json().job.id)).toMatchObject({ state: 'succeeded' });
    expect((await call('GET', '/api/admin/backups', operator)).json().backups[0].verifiedAt).toEqual(expect.any(String));
  });

  it('refuses a request to the agent without its token', async () => {
    const url = await startAgent();
    const response = await fetch(`${url}/v1/backups`);
    expect(response.status).toBe(401);
    const wrong = await fetch(`${url}/v1/backups`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });
});

