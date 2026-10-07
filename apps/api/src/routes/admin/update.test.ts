import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@syntra/db';
import { assignRole, createRole, createSession, createUser, PERMISSIONS, type AvailableRelease, type Permission } from '@syntra/core';
import { buildTestApp, createFakeScheduler } from '../../test-support.js';

// Tests do not run from a release, so the forge-facing calls are stood in for.
const forge = vi.hoisted(() => ({
  current: '1.21.0',
  releases: [] as AvailableRelease[],
}));
vi.mock('@syntra/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@syntra/core')>();
  return {
    ...actual,
    checkForUpdate: async () => {
      const latest = forge.releases[0] ?? null;
      return {
        current: forge.current,
        updatable: true,
        reason: null,
        latest,
        updateAvailable: latest !== null && actual.isNewer(latest.version, forge.current),
      };
    },
    fetchReleases: async () => ({ ok: true, releases: forge.releases }),
  };
});

const release = (version: string, notes: string, published = true): AvailableRelease => ({
  version,
  released: '2026-10-07T12:00:00Z',
  notes,
  migrations: [],
  assets: published ? [`syntra-${version}.tar.gz`, `syntra-${version}.tar.gz.sha256`] : [],
});

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let agent: Server | null = null;
afterEach(async () => {
  await ctx?.app.close();
  await new Promise<void>((resolve) => (agent ? agent.close(() => resolve()) : resolve()));
  agent = null;
});

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

/** A backup agent that answers /v1/status with a last backup at `lastBackupSuccessAt`. */
async function fakeAgent(lastBackupSuccessAt: string | null): Promise<string> {
  agent = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ health: { lastBackupSuccessAt } }),
    );
  });
  await new Promise<void>((resolve) => agent!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(agent!.address() as AddressInfo).port}`;
}

const preflight = (cookie: string) =>
  ctx.app.inject({ method: 'GET', url: '/api/admin/update/preflight', headers: { host: ctx.host, cookie } });

describe('GET /api/admin/update/preflight', () => {
  it('checks every release an update installs, and is not ready while files are missing', async () => {
    forge.current = '1.21.0';
    forge.releases = [
      release('1.23.0', 'Migrations\n- 20261121000000_audit_stream_history: adds a table. Does not rewrite data.', false),
      release('1.22.0', 'Migrations\n- 20261120000000_audit_streams: adds the AuditStream table. Does not rewrite data.'),
      release('1.21.0', 'No migrations.'),
    ];
    const agentUrl = await fakeAgent(new Date(Date.now() - 10 * 60_000).toISOString());
    ctx = await buildTestApp({
      scheduler: () => createFakeScheduler(),
      env: { RELEASE_REPO: 'acme/syntra', RELEASE_TOKEN: 'tok', RELEASE_ROOT: mkdtempSync(join(tmpdir(), 'syntra-root-')), BACKUP_AGENT_URL: agentUrl },
    });
    const owner = await cookieFor('owner', [PERMISSIONS.DEPLOYMENT_MANAGE]);
    const tenantAdmin = await cookieFor('admin', [PERMISSIONS.TENANT_MANAGE]);

    expect((await preflight(tenantAdmin)).statusCode).toBe(403);

    const response = await preflight(owner);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ target: '1.23.0', ready: false });
    expect(body.releases.map((r: { version: string }) => r.version)).toEqual(['1.22.0', '1.23.0']);
    const byId = Object.fromEntries(body.checks.map((check: { id: string }) => [check.id, check]));
    expect(byId['release-files']).toMatchObject({ status: 'fail' });
    expect(byId['releases']).toMatchObject({ status: 'info', detail: '2 releases since 1.21.0. Their notes are below.' });
    expect(byId['migrations'].items).toEqual([
      '20261120000000_audit_streams: adds the AuditStream table. Does not rewrite data.',
      '20261121000000_audit_stream_history: adds a table. Does not rewrite data.',
    ]);
    expect(['pass', 'warn', 'fail']).toContain(byId['disk'].status);
    expect(byId['backups']).toMatchObject({ status: 'pass', detail: 'Last backup 10 minutes ago.' });
  });

  it('is ready once the files are published, and says so when there is nothing to update to', async () => {
    forge.current = '1.22.0';
    forge.releases = [release('1.23.0', 'No migrations.')];
    ctx = await buildTestApp({
      scheduler: () => createFakeScheduler(),
      env: { RELEASE_REPO: 'acme/syntra', RELEASE_TOKEN: 'tok', RELEASE_ROOT: mkdtempSync(join(tmpdir(), 'syntra-root-')) },
    });
    const owner = await cookieFor('owner', [PERMISSIONS.DEPLOYMENT_MANAGE]);
    const ready = (await preflight(owner)).json();
    expect(ready.checks.find((check: { id: string }) => check.id === 'backups')).toMatchObject({ status: 'info' });
    expect(ready.checks.find((check: { id: string }) => check.id === 'release-files')).toMatchObject({ status: 'pass' });

    forge.current = '1.23.0';
    expect((await preflight(owner)).json()).toEqual({ target: null, ready: false, releases: [], checks: [] });
  });
});
