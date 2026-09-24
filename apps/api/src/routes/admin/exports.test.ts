import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  EXPORT_JOB,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  issueApiToken,
  localMasterKeyProvider,
  runExportJob,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp, createFakeScheduler, type FakeScheduler } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let scheduler: FakeScheduler;

/** The MASTER_KEY `buildTestApp` configures: what the job seals, the route opens. */
const MASTER = localMasterKeyProvider(Buffer.alloc(32, 7));
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function seedAdmin(login: string, permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id);
    return user;
  });
}

async function cookieFor(login: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  const token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const call = (method: 'GET' | 'POST', url: string, auth: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: auth.startsWith('Bearer ')
      ? { host: ctx.host, authorization: auth }
      : { host: ctx.host, cookie: auth },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

beforeEach(async () => {
  scheduler = createFakeScheduler();
  ctx = await buildTestApp({ scheduler: () => scheduler });
  await ctx.app.ready();
});

async function requestAuditExport(auth: string, params: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/admin/exports', auth, { kind: 'audit_log', params });
  expect(res.statusCode).toBe(202);
  return (res.json() as { export: { id: string; status: string } }).export;
}

describe('the export center', () => {
  it('queues an audit export, and the download is the sealed, watermarked file with its digest', async () => {
    const auditor = await seedAdmin('auditor', [PERMISSIONS.AUDIT_READ]);
    const cookie = await cookieFor('auditor');
    const created = await requestAuditExport(cookie, { action: 'auth.' });
    expect(created.status).toBe('queued');
    expect(scheduler.enqueued).toEqual([
      { name: EXPORT_JOB, data: { tenantId: ctx.tenantId, exportId: created.id } },
    ]);

    // Not ready yet: the file does not exist until the job has run.
    expect((await call('GET', `/api/admin/exports/${created.id}/download`, cookie)).statusCode).toBe(409);

    await runExportJob(ctx.tenantId, created.id, MASTER);
    const listed = (await call('GET', '/api/admin/exports', cookie)).json().exports as { id: string; status: string }[];
    expect(listed).toEqual([expect.objectContaining({ id: created.id, status: 'ready' })]);

    const download = await call('GET', `/api/admin/exports/${created.id}/download`, cookie);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="syntra-audit-log-/);
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.headers['x-syntra-export-sha256']).toBe(
      createHash('sha256').update(download.rawPayload).digest('hex'),
    );
    const watermark = JSON.parse(download.body.split('\n')[0]!) as Record<string, unknown>;
    expect(watermark).toMatchObject({
      type: 'syntra-export-watermark',
      export_id: created.id,
      tenant_id: ctx.tenantId,
      exported_by_user_id: auditor.id,
    });
  });

  it('503s rather than generating inline when no scheduler is running', async () => {
    await ctx.app.close();
    ctx = await buildTestApp();
    await seedAdmin('auditor', [PERMISSIONS.AUDIT_READ]);
    const res = await call('POST', '/api/admin/exports', await cookieFor('auditor'), { kind: 'audit_log' });
    expect(res.statusCode).toBe(503);
  });

  it('refuses an export the caller has no authority for, and a misspelt filter', async () => {
    await seedAdmin('reader', [PERMISSIONS.DIRECTORY_READ]);
    const cookie = await cookieFor('reader');
    const refused = await call('POST', '/api/admin/exports', cookie, { kind: 'audit_log' });
    expect(refused.statusCode).toBe(403);
    const govern = await call('POST', '/api/admin/exports', cookie, {
      kind: 'govern_access',
      params: { systemId: 'sys-1' },
    });
    expect(govern.statusCode).toBe(403);

    await seedAdmin('auditor', [PERMISSIONS.AUDIT_READ]);
    const typo = await call('POST', '/api/admin/exports', await cookieFor('auditor'), {
      kind: 'audit_log',
      params: { actr: '11111111-1111-4111-8111-111111111111' },
    });
    // Stripped, this would have exported the whole log and reported success.
    expect(typo.statusCode).toBe(400);
    const tooLong = await call('POST', '/api/admin/exports', await cookieFor('auditor'), {
      kind: 'audit_log',
      ttlHours: 96,
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('a machine token needs the export’s permissions among its own scopes', async () => {
    const svc = await seedAdmin('svc', [PERMISSIONS.AUDIT_READ, PERMISSIONS.DIRECTORY_READ]);
    const narrow = await withTenant(ctx.tenantId, (tx) =>
      issueApiToken(tx, {
        userId: svc.id,
        name: 'directory only',
        scopes: [PERMISSIONS.DIRECTORY_READ],
        expiresAt: null,
        createdBy: null,
      }),
    );
    const res = await call('POST', '/api/admin/exports', `Bearer ${narrow.token}`, { kind: 'audit_log' });
    expect(res.statusCode).toBe(403);
  });

  it('shows everybody’s exports only to tenant.manage, which may revoke any of them', async () => {
    await seedAdmin('auditor', [PERMISSIONS.AUDIT_READ]);
    await seedAdmin('owner', [PERMISSIONS.TENANT_MANAGE]);
    const auditorCookie = await cookieFor('auditor');
    const ownerCookie = await cookieFor('owner');
    const created = await requestAuditExport(auditorCookie);
    await runExportJob(ctx.tenantId, created.id, MASTER);

    expect((await call('GET', '/api/admin/exports?scope=all', auditorCookie)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/exports', ownerCookie)).json().exports).toEqual([]);
    expect((await call('GET', '/api/admin/exports?scope=all', ownerCookie)).json().exports).toHaveLength(1);

    const revoked = await call('POST', `/api/admin/exports/${created.id}/revoke`, ownerCookie, {});
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().export).toMatchObject({ status: 'revoked' });

    const gone = await call('GET', `/api/admin/exports/${created.id}/download`, auditorCookie);
    expect(gone.statusCode).toBe(410);
    // The owner revoked it, but it was never theirs to download.
    const notTheirs = await call('GET', `/api/admin/exports/${created.id}/download`, ownerCookie);
    expect(notTheirs.statusCode).toBe(404);
  });

  it('an administrator without tenant.manage cannot revoke, or see, somebody else’s export', async () => {
    await seedAdmin('auditor', [PERMISSIONS.AUDIT_READ]);
    await seedAdmin('other', [PERMISSIONS.AUDIT_READ]);
    const created = await requestAuditExport(await cookieFor('auditor'));
    const otherCookie = await cookieFor('other');
    expect((await call('GET', `/api/admin/exports/${created.id}`, otherCookie)).statusCode).toBe(404);
    expect((await call('POST', `/api/admin/exports/${created.id}/revoke`, otherCookie, {})).statusCode).toBe(404);
  });
});
