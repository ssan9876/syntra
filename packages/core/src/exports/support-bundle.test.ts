import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent } from '../audit/audit-service.js';
import type { QueueInspector } from '../jobs/job-health.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { configurationFingerprint } from '../lifecycle/management.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { assignRole, createRole } from '../rbac/rbac-service.js';
import { createSource } from '../sync/source-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { ExportRefusedError, downloadExport, requestExport, runExportJob } from './export-service.js';
import { SUPPORT_BUNDLE_MAX_WINDOW_MS, buildSupportBundle, supportBundleWindow } from './support-bundle.js';

/*
 * The operational support bundle (backlog #64). The redaction test seeds a
 * secret or a piece of personal data into every table the bundle reads -- a
 * vault-sealed bind password, credentials in a target URL, a DN naming a
 * person, error messages carrying an email address, a password pair and a
 * bearer token, a write stop's reason naming somebody, an audit payload with
 * both -- and asserts that NONE of it survives into the file, while the
 * operational facts (fingerprints, statuses, error classes, counts) do.
 */

const provider = localMasterKeyProvider(randomBytes(32));
const empty: QueueInspector = async () => [];

const SECRETS = [
  'S3cret-Bind-Passw0rd',
  'Pa55w0rd-in-url',
  'hunter2-SEEKRIT',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXlhIn0.c2lnbmF0dXJl',
  ['sk', 'live', '9fA2bC7dE1fG3hJ5kL8mN0pQ4rS6tU'].join('_'),
];
const PERSONAL = ['Maya', 'Okafor', 'maya.okafor@acme.test', 'maya.private@example.org', '+44 20 7946 0958'];

let tenantId: string;
let otherTenantId: string;
let admin: string;
let auditor: string;
let targetConfig: Record<string, unknown>;

function fakeScheduler(): Scheduler {
  return {
    start: async () => {},
    stop: async () => {},
    register: () => {},
    enqueue: async () => 'job-1',
    schedule: async () => {},
    unschedule: async () => {},
    missingSchedules: async () => [],
  };
}

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } })).id;
  targetConfig = {
    url: 'ldaps://svc-syntra:Pa55w0rd-in-url@dc.acme.test:636',
    tlsMode: 'ldaps',
    bindDn: 'CN=Maya Okafor,OU=Staff,DC=acme,DC=test',
    apiKey: ['sk', 'live', '9fA2bC7dE1fG3hJ5kL8mN0pQ4rS6tU'].join('_'),
  };
  await withTenant(tenantId, async (tx) => {
    admin = (await tx.user.create({ data: { tenantId, login: 'maya.okafor', email: 'maya.okafor@acme.test', displayName: 'Maya Okafor' } })).id;
    auditor = (await tx.user.create({ data: { tenantId, login: 'auditor', email: 'auditor@acme.test', displayName: 'Auditor' } })).id;
    const role = await createRole(tx, 'Tenant admin', [PERMISSIONS.TENANT_MANAGE]);
    await assignRole(tx, admin, role.id);
    const auditRole = await createRole(tx, 'Auditor', [PERMISSIONS.AUDIT_READ]);
    await assignRole(tx, auditor, auditRole.id);

    await tx.person.create({
      data: { tenantId, givenName: 'Maya', familyName: 'Okafor', businessEmail: 'maya.okafor@acme.test', personalEmail: 'maya.private@example.org' },
    });
    const source = await createSource(tx, provider, {
      name: 'Maya Okafor test LDAP',
      config: {
        url: 'ldap://localhost:1389',
        bindDn: 'CN=Maya Okafor,OU=Staff,DC=acme,DC=test',
        userSearchBase: 'ou=Shared,dc=acme,dc=test',
        groupSearchBase: 'ou=Shared,dc=acme,dc=test',
        orgUnitSearchBase: 'ou=Shared,dc=acme,dc=test',
        userFilter: '(objectClass=inetOrgPerson)',
        groupFilter: '(objectClass=groupOfNames)',
        anchorAttribute: 'entryUUID',
        pageSize: 2,
        rejectUnauthorized: true,
      },
      bindPassword: 'S3cret-Bind-Passw0rd',
    });
    const target = await tx.targetSystem.create({
      data: { tenantId, name: 'Maya Okafor AD', config: targetConfig as never, secretName: 't', externalWritesPausedAt: new Date(), externalWritesPauseReason: 'Maya Okafor reported a compromised account; call +44 20 7946 0958' },
    });
    await tx.tenantExternalWriteStop.create({
      data: { tenantId, pausedAt: new Date(), pausedByUserId: admin, pauseReason: 'Investigating maya.okafor@acme.test' },
    });
    await tx.syncRun.create({
      data: { tenantId, sourceId: source.id, status: 'failed', finishedAt: new Date(), error: 'bind failed for maya.okafor@acme.test with password=hunter2-SEEKRIT' },
    });
    await tx.provisionRun.create({
      data: { tenantId, targetSystemId: target.id, status: 'failed', finishedAt: new Date(), error: 'HTTP 401 with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXlhIn0.c2lnbmF0dXJl' },
    });
    await tx.connectionReadinessCheck.create({
      data: { tenantId, systemKind: 'target', systemId: target.id, configurationFingerprint: configurationFingerprint(targetConfig), status: 'failed', message: 'connect ETIMEDOUT while binding CN=Maya Okafor,OU=Staff,DC=acme,DC=test' },
    });
    await recordEvent(tx, {
      actorUserId: admin,
      action: 'user.update',
      targetType: 'User',
      targetId: admin,
      outcome: 'success',
      sourceIp: '203.0.113.7',
      payload: { email: 'maya.okafor@acme.test', password: 'hunter2-SEEKRIT', displayName: 'Maya Okafor' },
    });
  });
  // Another tenant's failure must not appear in this tenant's bundle.
  await withTenant(otherTenantId, async (tx) => {
    await recordEvent(tx, { actorUserId: null, action: 'other.tenant.event', targetType: 'Tenant', targetId: otherTenantId, outcome: 'failure', sourceIp: null, payload: {} });
  });
});

const window = () => ({ from: new Date(Date.now() - 60 * 60_000), to: new Date(Date.now() + 1_000) });

describe('buildSupportBundle', () => {
  it('carries fingerprints, statuses, error classes and counts, and no seeded secret or personal data', async () => {
    const sections = await buildSupportBundle(tenantId, window(), { inspector: empty });
    const text = JSON.stringify(sections);

    for (const secret of SECRETS) expect(text, `secret ${secret}`).not.toContain(secret);
    for (const personal of PERSONAL) expect(text, `personal ${personal}`).not.toContain(personal);
    expect(text).not.toContain('Investigating');
    expect(text).not.toContain('compromised account');

    const byName = Object.fromEntries(sections.map((s) => [s.name, s.data as Record<string, unknown>]));
    expect(Object.keys(byName)).toEqual([
      'software', 'tenant', 'configuration', 'write_stops', 'connector_readiness', 'job_health', 'recent_failures', 'audit_counts', 'redaction',
    ]);
    // The configuration is present as its fingerprint only.
    expect(text).toContain(configurationFingerprint(targetConfig));
    expect(byName.write_stops).toMatchObject({ tenantWide: { active: true, reasonProvided: true } });
    expect(byName.connector_readiness).toEqual([expect.objectContaining({ status: 'failed', errorClass: 'timeout', current: true })]);
    const failures = byName.recent_failures as { recent: { kind: string; errorClass: string }[] };
    expect(failures.recent.map((f) => [f.kind, f.errorClass]).sort()).toEqual([
      ['provision_run', 'unauthorized'],
      ['sync_run', 'unauthorized'],
    ]);
    const audit = byName.audit_counts as { byAction: { action: string; count: number }[] };
    expect(audit.byAction).toContainEqual(expect.objectContaining({ action: 'user.update', count: 1 }));
    expect(audit.byAction.map((a) => a.action)).not.toContain('other.tenant.event');
    expect((byName.tenant as { signInPolicy: { minimumLength: number } }).signInPolicy.minimumLength).toBe(12);
    expect((byName.software as { migrations: { applied: number } }).migrations.applied).toBeGreaterThan(80);
  });

  it('refuses a window longer than seven days', async () => {
    const to = new Date();
    await expect(
      buildSupportBundle(tenantId, { from: new Date(to.getTime() - SUPPORT_BUNDLE_MAX_WINDOW_MS - 1), to }, { inspector: empty }),
    ).rejects.toThrow(/seven days/);
    expect(() => supportBundleWindow({ from: new Date(to.getTime() - 8 * 86_400_000).toISOString() }, to)).toThrow(/seven days/);
    expect(supportBundleWindow({}, to)).toEqual({ from: new Date(to.getTime() - 86_400_000), to });
  });
});

describe('support bundle through the export service', () => {
  const request = (userId: string, params: Record<string, unknown> = {}) =>
    requestExport(fakeScheduler(), tenantId, {
      kind: 'support_bundle',
      params,
      requestedByUserId: userId,
      requestedViaToken: false,
      sourceIp: '203.0.113.9',
    });

  it('needs tenant.manage, fixes the window at request, and downloads a watermarked, redacted file', async () => {
    await expect(request(auditor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(request(admin, { from: new Date(Date.now() - 8 * 86_400_000).toISOString() })).rejects.toBeInstanceOf(ExportRefusedError);

    const created = await request(admin);
    const params = created.params as { from: string; to: string };
    expect(Date.parse(params.to) - Date.parse(params.from)).toBe(86_400_000);

    expect(await runExportJob(tenantId, created.id, provider)).toBe('ready');
    const file = await downloadExport(tenantId, { exportId: created.id, userId: admin, provider, sourceIp: null });
    const text = file.body.toString('utf8');
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as { type: string; name?: string });
    expect(lines[0]).toMatchObject({ type: 'syntra-export-watermark', kind: 'support_bundle', exported_by_user_id: admin, tenant_id: tenantId });
    expect(lines.at(-1)).toMatchObject({ type: 'syntra-export-end', section_count: 9 });
    expect(lines.filter((l) => l.type === 'section').map((l) => l.name)).toContain('job_health');
    expect(file.filename).toMatch(/^syntra-support-bundle-/);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    for (const personal of PERSONAL) expect(text).not.toContain(personal);

    const actions = await withTenant(tenantId, async (tx) =>
      (await tx.auditEvent.findMany({ where: { action: { startsWith: 'export.' } }, orderBy: { sequence: 'asc' } })).map((e) => `${e.action}:${e.outcome}`),
    );
    expect(actions).toEqual(['export.request:failure', 'export.request:success', 'export.ready:success', 'export.download:success']);
  });
});
