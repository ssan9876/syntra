import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent, verifyChain } from '../audit/audit-service.js';
import { createUser } from '../directory/user-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { assignRole, createRole, revokeRole } from '../rbac/rbac-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  EXPORT_BATCH_ROWS,
  EXPORT_JOB,
  EXPORT_SWEEP_JOB,
  ExportRefusedError,
  downloadExport,
  listExports,
  registerExportJobs,
  requestExport,
  revokeExport,
  runExportJob,
  scheduleExportSweep,
  sweepExports,
} from './export-service.js';

const provider = localMasterKeyProvider(randomBytes(32));

let tenantId: string;
let otherTenantId: string;
let auditor: string;
let outsider: string;
let auditorRoleId: string;

function fakeScheduler(): Scheduler & { enqueued: { name: string; data: unknown }[] } {
  const enqueued: { name: string; data: unknown }[] = [];
  return {
    enqueued,
    start: async () => {},
    stop: async () => {},
    register: () => {},
    enqueue: async (name, data) => {
      enqueued.push({ name, data });
      return `job-${enqueued.length}`;
    },
    schedule: async () => {},
    unschedule: async () => {},
    missingSchedules: async () => [],
  };
}

const actions = () =>
  withTenant(tenantId, async (tx) =>
    (await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } })).map((e) => `${e.action}:${e.outcome}`),
  );

const request = (userId: string, params: Record<string, unknown> = {}, ttlHours?: number) =>
  requestExport(fakeScheduler(), tenantId, {
    kind: 'audit_log',
    params,
    ...(ttlHours === undefined ? {} : { ttlHours }),
    requestedByUserId: userId,
    requestedViaToken: false,
    sourceIp: '203.0.113.9',
  });

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } })).id;
  await withTenant(tenantId, async (tx) => {
    auditor = (await createUser(tx, { login: 'auditor', email: 'auditor@acme.test', displayName: 'Auditor' })).id;
    outsider = (await createUser(tx, { login: 'outsider', email: 'outsider@acme.test', displayName: 'Outsider' })).id;
    const role = await createRole(tx, 'Auditor', [PERMISSIONS.AUDIT_READ]);
    auditorRoleId = role.id;
    await assignRole(tx, auditor, role.id);
    for (const action of ['auth.login', 'user.update', 'auth.logout']) {
      await recordEvent(tx, {
        actorUserId: auditor,
        action,
        targetType: 'User',
        targetId: outsider,
        outcome: 'success',
        sourceIp: null,
        payload: { note: action },
      });
    }
  });
});

describe('requesting an export', () => {
  it('records the request, audits it, and queues exactly one job for it', async () => {
    const scheduler = fakeScheduler();
    const created = await requestExport(scheduler, tenantId, {
      kind: 'audit_log',
      params: { action: 'auth.' },
      requestedByUserId: auditor,
      requestedViaToken: false,
      sourceIp: null,
    });
    expect(created).toMatchObject({ status: 'queued', kind: 'audit_log', format: 'jsonl', ttlHours: 24 });
    expect(scheduler.enqueued).toEqual([{ name: EXPORT_JOB, data: { tenantId, exportId: created.id } }]);
    expect((await actions()).at(-1)).toBe('export.request:success');
  });

  it('refuses a requester without the permission, and the refusal is on the record', async () => {
    const refusal = await request(outsider).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ExportRefusedError);
    expect((refusal as ExportRefusedError).code).toBe('forbidden');
    expect((await actions()).at(-1)).toBe('export.request:failure');
    expect(await withTenant(tenantId, (tx) => tx.dataExport.count())).toBe(0);
  });

  it('refuses a lifetime outside the documented bound', async () => {
    await expect(request(auditor, {}, 73)).rejects.toMatchObject({ code: 'state' });
    await expect(request(auditor, {}, 0)).rejects.toMatchObject({ code: 'state' });
  });
});

describe('generating and downloading', () => {
  it('seals a watermarked file whose digest verifies, and hands it only to its requester', async () => {
    const created = await request(auditor, { action: 'auth.' });
    expect(await runExportJob(tenantId, created.id, provider)).toBe('ready');

    const row = await withTenant(tenantId, (tx) => tx.dataExport.findUniqueOrThrow({ where: { id: created.id } }));
    expect(row).toMatchObject({ status: 'ready', rowCount: 2, authorityFingerprint: 'tenant' });
    expect(row.expiresAt!.getTime() - row.completedAt!.getTime()).toBe(24 * 3_600_000);
    // At rest it is ciphertext: not one of the exported action names appears.
    expect(Buffer.from(row.ciphertext!).toString('utf8')).not.toContain('auth.login');

    const file = await downloadExport(tenantId, { exportId: created.id, userId: auditor, provider, sourceIp: null });
    expect(createHash('sha256').update(file.body).digest('hex')).toBe(row.sha256);
    expect(file.sha256).toBe(row.sha256);
    const lines = file.body.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      type: 'syntra-export-watermark',
      export_id: created.id,
      tenant_id: tenantId,
      exported_by_user_id: auditor,
      filters: { action: 'auth.' },
    });
    expect(lines.slice(1, -1).map((l) => l['action'])).toEqual(['auth.login', 'auth.logout']);
    expect(lines.at(-1)).toMatchObject({ type: 'syntra-export-end', event_count: 2 });

    // Somebody else's export does not exist, to them.
    await expect(
      downloadExport(tenantId, { exportId: created.id, userId: outsider, provider, sourceIp: null }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const after = await withTenant(tenantId, (tx) => tx.dataExport.findUniqueOrThrow({ where: { id: created.id } }));
    expect(after.downloadCount).toBe(1);
    expect(await actions()).toEqual(
      expect.arrayContaining(['export.request:success', 'export.ready:success', 'export.download:success']),
    );
    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toEqual({ valid: true });
  });

  it('is invisible to another tenant', async () => {
    const created = await request(auditor);
    await runExportJob(tenantId, created.id, provider);
    expect(await withTenant(otherTenantId, (tx) => tx.dataExport.findMany())).toEqual([]);
    await expect(
      downloadExport(otherTenantId, { exportId: created.id, userId: auditor, provider, sourceIp: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reads the log in bounded batches, in chain order, with no repeat at a batch boundary', async () => {
    await withTenant(
      tenantId,
      (tx) =>
        tx.$executeRawUnsafe(`
          INSERT INTO "AuditEvent" ("id", "tenantId", "sequence", "occurredAt", "action", "targetType", "outcome", "payload", "prevHash", "hash")
          SELECT gen_random_uuid(), '${tenantId}'::uuid, 3 + g, now(), 'bulk.event', 'User', 'success', '{}'::jsonb, 'x', 'x'
          FROM generate_series(1, ${EXPORT_BATCH_ROWS * 2 + 5}) AS g`),
      { timeoutMs: 60_000 },
    );
    const created = await request(auditor, { action: 'bulk.' });
    await runExportJob(tenantId, created.id, provider);
    const file = await downloadExport(tenantId, { exportId: created.id, userId: auditor, provider, sourceIp: null });
    const events = file.body.toString('utf8').trim().split('\n').slice(1, -1)
      .map((l) => JSON.parse(l) as { sequence: number });
    expect(events).toHaveLength(EXPORT_BATCH_ROWS * 2 + 5);
    // Chain order, no repeats across batch boundaries.
    expect(events.every((e, i) => i === 0 || e.sequence === events[i - 1]!.sequence + 1)).toBe(true);
  });

  it('re-checks the permission when the job runs: a role removed while queued stops the export', async () => {
    const created = await request(auditor);
    await withTenant(tenantId, (tx) => revokeRole(tx, auditor, auditorRoleId));
    expect(await runExportJob(tenantId, created.id, provider)).toBe('failed');
    const row = await withTenant(tenantId, (tx) => tx.dataExport.findUniqueOrThrow({ where: { id: created.id } }));
    expect(row).toMatchObject({ status: 'failed', ciphertext: null });
    expect(row.error).toMatch(/no longer holds/);
    expect((await actions()).at(-1)).toBe('export.fail:failure');
  });

  it('re-checks the permission at download, and audits the refusal', async () => {
    const created = await request(auditor);
    await runExportJob(tenantId, created.id, provider);
    await withTenant(tenantId, (tx) => revokeRole(tx, auditor, auditorRoleId));
    await expect(
      downloadExport(tenantId, { exportId: created.id, userId: auditor, provider, sourceIp: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await actions()).at(-1)).toBe('export.download:failure');
  });

  it('runs a job once: a second delivery of the same job does nothing', async () => {
    const created = await request(auditor);
    expect(await runExportJob(tenantId, created.id, provider)).toBe('ready');
    expect(await runExportJob(tenantId, created.id, provider)).toBeNull();
  });
});

describe('expiry, revocation and the sweep', () => {
  it('refuses a download past expiry before the sweep has run, and the sweep erases it once', async () => {
    const created = await request(auditor, {}, 1);
    await runExportJob(tenantId, created.id, provider);
    const later = new Date(Date.now() + 2 * 3_600_000);
    await expect(
      downloadExport(tenantId, { exportId: created.id, userId: auditor, provider, sourceIp: null, now: later }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect((await withTenant(tenantId, (tx) => listExports(tx, { userId: auditor, all: false, now: later })))[0])
      .toMatchObject({ status: 'expired' });

    expect(await sweepExports(tenantId, later)).toEqual({ expired: 1, abandoned: 0 });
    expect(await sweepExports(tenantId, later)).toEqual({ expired: 0, abandoned: 0 });
    const row = await withTenant(tenantId, (tx) => tx.dataExport.findUniqueOrThrow({ where: { id: created.id } }));
    expect(row).toMatchObject({ status: 'expired', ciphertext: null, wrappedDek: null });
    expect(row.purgedAt).not.toBeNull();
    expect((await actions()).at(-1)).toBe('export.expire:success');
  });

  it('fails an export no worker finished', async () => {
    const created = await request(auditor);
    const later = new Date(Date.now() + 3 * 3_600_000);
    expect(await sweepExports(tenantId, later)).toEqual({ expired: 0, abandoned: 1 });
    expect(await runExportJob(tenantId, created.id, provider)).toBeNull();
  });

  it('revokes: erases the file, refuses the download, and lets a tenant administrator revoke anybody’s', async () => {
    const created = await request(auditor);
    await runExportJob(tenantId, created.id, provider);
    // The outsider cannot even see it without tenant.manage...
    await expect(
      revokeExport(tenantId, { exportId: created.id, actorUserId: outsider, manageAll: false, sourceIp: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // ...and can revoke it with it.
    const revoked = await revokeExport(tenantId, {
      exportId: created.id,
      actorUserId: outsider,
      manageAll: true,
      sourceIp: null,
    });
    expect(revoked).toMatchObject({ status: 'revoked', revokedByUserId: outsider });
    const row = await withTenant(tenantId, (tx) => tx.dataExport.findUniqueOrThrow({ where: { id: created.id } }));
    expect(row.ciphertext).toBeNull();
    await expect(
      downloadExport(tenantId, { exportId: created.id, userId: auditor, provider, sourceIp: null }),
    ).rejects.toMatchObject({ code: 'revoked' });
    await expect(
      revokeExport(tenantId, { exportId: created.id, actorUserId: auditor, manageAll: false, sourceIp: null }),
    ).rejects.toMatchObject({ code: 'state' });
    expect(await actions()).toEqual(expect.arrayContaining(['export.revoke:success', 'export.download:failure']));
  });

  it('a revocation while queued means the job never generates anything', async () => {
    const created = await request(auditor);
    await revokeExport(tenantId, { exportId: created.id, actorUserId: auditor, manageAll: false, sourceIp: null });
    expect(await runExportJob(tenantId, created.id, provider)).toBeNull();
  });

  it('the database refuses a ready export with no file, and a revoked one that still holds it', async () => {
    const created = await request(auditor);
    await expect(
      withTenant(tenantId, (tx) =>
        tx.dataExport.update({ where: { id: created.id }, data: { status: 'ready' } }),
      ),
    ).rejects.toThrow(/DataExport_ready_complete/);
    await runExportJob(tenantId, created.id, provider);
    await expect(
      withTenant(tenantId, (tx) =>
        tx.dataExport.update({ where: { id: created.id }, data: { status: 'revoked', revokedAt: new Date() } }),
      ),
    ).rejects.toThrow(/DataExport_terminal_erased/);
  });
});

describe('job registration', () => {
  it('registers both queues and schedules the sweep per tenant under its own key', async () => {
    const registered: string[] = [];
    const schedules: unknown[] = [];
    const scheduler: Scheduler = {
      ...fakeScheduler(),
      register: (name) => {
        registered.push(name);
      },
      schedule: async (...args) => {
        schedules.push(args);
      },
    };
    registerExportJobs(scheduler, provider);
    await scheduleExportSweep(scheduler, 'tenant-1');
    expect(registered).toEqual([EXPORT_JOB, EXPORT_SWEEP_JOB]);
    expect(schedules).toEqual([[EXPORT_SWEEP_JOB, '*/15 * * * *', { tenantId: 'tenant-1' }, 'export-sweep-tenant-1']]);
  });
});
