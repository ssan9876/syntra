import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  SECURITY_NOTIFICATION_CATEGORY_KEYS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  localMasterKeyProvider,
  putSecret,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { securityNotificationCategories } from '@syntra/contracts';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
// The HR-feed connector, replaced: its test accepts exactly one password, so
// the workflow's verify and complete steps have a real pass and a real fail
// to record without an SFTP server. The same seam person-sources.test.ts uses.
const connectorFor = vi.hoisted(() => vi.fn());
vi.mock('@syntra/connectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@syntra/connectors')>()),
  personSourceConnectorFor: connectorFor,
}));
const ACCEPTED = 'new-password';

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);
// The key `buildTestApp` configures, so a secret sealed here opens there.
const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

async function seedAdmin(login: string, permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `Role ${login}`, permissions);
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
  const portal = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function hrFeed(): Promise<string> {
  return withTenant(ctx.tenantId, async (tx) => {
    const source = await tx.personSource.create({
      data: {
        tenantId: ctx.tenantId,
        name: 'HR nightly',
        type: 'sftpDelimited',
        feedMode: 'snapshot',
        config: { host: 'sftp.example.test', username: 'syntra', path: '/out/people.csv' },
        secretName: 'personSource.hr.credential',
      },
    });
    await putSecret(tx, provider, 'personSource.hr.credential', 'old-password');
    return source.id;
  });
}

async function adTarget(): Promise<string> {
  return withTenant(ctx.tenantId, async (tx) => {
    const target = await tx.targetSystem.create({
      data: {
        tenantId: ctx.tenantId,
        name: 'AD',
        type: 'activeDirectory',
        config: { url: 'ldaps://127.0.0.1:9', tlsMode: 'ldaps', bindDn: 'CN=svc', baseDn: 'DC=acme,DC=test' },
        secretName: 'target.ad.bind',
      },
    });
    await putSecret(tx, provider, 'target.ad.bind', 'old-password');
    return target.id;
  });
}

beforeEach(async () => {
  connectorFor.mockReset();
  connectorFor.mockReturnValue({
    test: async (config: { password?: string }) =>
      config.password === ACCEPTED
        ? { ok: true, message: 'connected; the file is readable' }
        : { ok: false, message: 'authentication refused by the SFTP server' },
  });
  ctx = await buildTestApp();
  await ctx.app.ready();
});
afterEach(async () => {
  await ctx.app.close();
});


describe('the credential inventory', () => {
  it('needs audit.read to read and tenant.manage to change', async () => {
    await seedAdmin('reader', [PERMISSIONS.DIRECTORY_READ]);
    await seedAdmin('auditor', [PERMISSIONS.AUDIT_READ]);
    expect((await call('GET', '/api/admin/credentials', await cookieFor('reader'))).statusCode).toBe(403);
    const auditor = await cookieFor('auditor');
    expect((await call('GET', '/api/admin/credentials', auditor)).statusCode).toBe(200);
    expect((await call('POST', '/api/admin/credentials/scan', auditor, {})).statusCode).toBe(403);
  });

  it('lists an HR-feed credential with no secret in it, and takes an owner and a declared expiry', async () => {
    const admin = await seedAdmin('admin', [PERMISSIONS.TENANT_MANAGE, PERMISSIONS.AUDIT_READ]);
    const sourceId = await hrFeed();
    const cookie = await cookieFor('admin');

    const listed = await call('GET', '/api/admin/credentials', cookie);
    expect(listed.statusCode).toBe(200);
    expect(listed.payload).not.toContain('old-password');
    expect(listed.payload).not.toContain('personSource.hr.credential');
    const item = listed.json().items.find((i: { kind: string }) => i.kind === 'person_source_secret');
    expect(item).toMatchObject({ label: 'SFTP password or private key', status: 'unknown', openRotation: null });

    const declared = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const patched = await call('PATCH', `/api/admin/credentials/${item.key}`, cookie, {
      ownerUserId: admin.id,
      declaredExpiresAt: declared,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ expirySource: 'declared', status: 'expiring', ownerName: 'admin' });

    // A misspelled field is refused rather than ignored.
    expect((await call('PATCH', `/api/admin/credentials/${item.key}`, cookie, { declaredExpiry: declared })).statusCode).toBe(400);
    const other = `person_source_secret.${sourceId.slice(0, -1)}${sourceId.endsWith('0') ? '1' : '0'}`;
    expect((await call('PATCH', `/api/admin/credentials/${other}`, cookie, { note: 'x' })).statusCode).toBe(404);

    // The scan raises the 14-day alert once and mails the owner.
    const scanned = await call('POST', '/api/admin/credentials/scan', cookie, {});
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json()).toMatchObject({ alertsRaised: 1 });
    expect((await call('POST', '/api/admin/credentials/scan', cookie, {})).json()).toMatchObject({ alertsRaised: 0 });
    const outbox = await withTenant(ctx.tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox.map((m) => [m.template, m.to])).toEqual([['security-credential-expiring', 'admin@acme.test']]);
  });
});

describe('the rotation workflow', () => {
  it('needs the authority that governs the system', async () => {
    await seedAdmin('sync', [PERMISSIONS.SYNC_MANAGE]);
    const targetId = await adTarget();
    const refused = await call('POST', '/api/admin/credentials/rotations', await cookieFor('sync'), {
      systemKind: 'target',
      systemId: targetId,
      secret: ACCEPTED,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().detail).toBe('Requires provision.manage');
  });

  it('stages, verifies against the saved configuration, cuts over and completes with evidence', async () => {
    await seedAdmin('sync', [PERMISSIONS.SYNC_MANAGE, PERMISSIONS.AUDIT_READ]);
    const sourceId = await hrFeed();
    const cookie = await cookieFor('sync');

    const staged = await call('POST', '/api/admin/credentials/rotations', cookie, {
      systemKind: 'person_source',
      systemId: sourceId,
      secret: ACCEPTED,
      reason: 'Quarterly rotation',
    });
    expect(staged.statusCode).toBe(201);
    expect(staged.payload).not.toContain(ACCEPTED);
    const id = staged.json().id as string;

    const second = await call('POST', '/api/admin/credentials/rotations', cookie, {
      systemKind: 'person_source',
      systemId: sourceId,
      secret: 'another',
    });
    expect(second.statusCode).toBe(409);
    const early = await call('POST', `/api/admin/credentials/rotations/${id}/cutover`, cookie);
    expect(early.statusCode).toBe(409);
    expect(early.json().type).toContain('rotation-not-verified');

    const verified = await call('POST', `/api/admin/credentials/rotations/${id}/verify`, cookie);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ status: 'verified', verificationOk: true });

    const inventory = await call('GET', '/api/admin/credentials', cookie);
    const item = inventory.json().items.find((i: { kind: string }) => i.kind === 'person_source_secret');
    expect(item.openRotation).toMatchObject({ id, status: 'verified' });

    const cut = await call('POST', `/api/admin/credentials/rotations/${id}/cutover`, cookie);
    expect(cut.json()).toMatchObject({ status: 'cut_over', overlapActive: true });
    const done = await call('POST', `/api/admin/credentials/rotations/${id}/complete`, cookie);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'completed' });
    expect(done.json().evidence.map((e: { step: string }) => e.step)).toEqual(['staged', 'verified', 'cut_over', 'completed']);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'credential.rotation' } }, orderBy: { sequence: 'asc' } }),
    );
    expect(events.map((e) => e.action)).toEqual([
      'credential.rotation_staged',
      'credential.rotation_verified',
      'credential.rotation_cut_over',
      'credential.rotation_completed',
    ]);
    // Nobody reads a secret back: not the audit log, not the listing.
    expect(JSON.stringify(events)).not.toContain(ACCEPTED);
    const listed = await call('GET', '/api/admin/credentials/rotations', cookie);
    expect(listed.json().rotations).toHaveLength(1);
    expect(listed.payload).not.toContain('credential-rotation.');
  });

  it('records a failed verification and refuses the cut-over', async () => {
    await seedAdmin('sync', [PERMISSIONS.SYNC_MANAGE]);
    const sourceId = await hrFeed();
    const cookie = await cookieFor('sync');
    const staged = await call('POST', '/api/admin/credentials/rotations', cookie, {
      systemKind: 'person_source',
      systemId: sourceId,
      secret: 'wrong-password',
    });
    const id = staged.json().id as string;
    const verified = await call('POST', `/api/admin/credentials/rotations/${id}/verify`, cookie);
    expect(verified.json()).toMatchObject({ status: 'verification_failed', verificationOk: false });
    expect(verified.json().verificationMessage).toMatch(/authentication refused/);
    expect((await call('POST', `/api/admin/credentials/rotations/${id}/cutover`, cookie)).statusCode).toBe(409);
    const cancelled = await call('POST', `/api/admin/credentials/rotations/${id}/cancel`, cookie);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
  });
});

describe('the security notification policy', () => {
  it('lists the categories with their actions and saves which ones email administrators', async () => {
    await seedAdmin('admin', [PERMISSIONS.TENANT_MANAGE]);
    const cookie = await cookieFor('admin');
    const read = await call('GET', '/api/admin/security-notifications', cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ emailCategories: [], alertDays: [30, 14, 7, 1] });
    expect(read.json().categories.find((c: { key: string }) => c.key === 'data_exports').actions).toContain('export.request');

    const saved = await call('PUT', '/api/admin/security-notifications', cookie, {
      emailCategories: ['write_stops', 'data_exports'],
      alertDays: [7, 60, 7],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ emailCategories: ['data_exports', 'write_stops'], alertDays: [60, 7] });
    expect((await call('PUT', '/api/admin/security-notifications', cookie, { emailCategories: ['everything'] })).statusCode).toBe(400);
    expect((await call('PUT', '/api/admin/security-notifications', cookie, { alertDays: [0] })).statusCode).toBe(400);
  });

  it('is the same category list in contracts and in core', () => {
    expect([...securityNotificationCategories].sort()).toEqual([...SECURITY_NOTIFICATION_CATEGORY_KEYS].sort());
  });

  it('announces a replaced connector credential as a security event', async () => {
    await seedAdmin('sync', [PERMISSIONS.SYNC_MANAGE]);
    const sourceId = await hrFeed();
    const cookie = await cookieFor('sync');
    const patched = await call('PATCH', `/api/admin/person-sources/${sourceId}`, cookie, { credential: 'replaced-value' });
    expect(patched.statusCode).toBe(200);
    const changed = await withTenant(ctx.tenantId, (tx) => tx.auditEvent.findMany({ where: { action: 'credential.changed' } }));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ targetType: 'PersonSource', targetId: sourceId });
    expect(JSON.stringify(changed)).not.toContain('replaced-value');
  });
});
