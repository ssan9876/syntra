import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { assignRole, createRole } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { issueApiToken } from '../auth/api-token-service.js';
import { recordEvent, verifyChain } from '../audit/audit-service.js';
import { getSecret, putSecret } from '../vault/vault-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { ensureActiveKey } from '../keys/signing-key-service.js';
import { listIncidents } from '../health/incidents.js';
import { alertStage, buildCredentialInventory, credentialKey, statusFor } from './inventory.js';
import { scanCredentials, updateCredentialMetadata, updateSecurityNotificationSettings } from './expiry-scan.js';
import {
  cancelRotation,
  completeRotation,
  cutOverRotation,
  RotationRefusedError,
  rollbackRotation,
  stageRotation,
  verifyRotation,
  type RotationTester,
} from './rotation.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const DAY = 86_400_000;
const now = new Date('2026-09-23T12:00:00Z');

let tenantId: string;
let admin: string;
let owner: string;
let targetId: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  await withTenant(tenantId, async (tx) => {
    admin = (await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Admin' })).id;
    owner = (await createUser(tx, { login: 'owner', email: 'owner@acme.test', displayName: 'Owner' })).id;
    const role = await createRole(tx, 'Tenant admin', [PERMISSIONS.TENANT_MANAGE]);
    await assignRole(tx, admin, role.id);
    targetId = (
      await tx.targetSystem.create({
        data: { tenantId, name: 'Entra', type: 'entraId', config: { tenantId: 'contoso.example', clientId: 'app-1' }, secretName: 'target.entra.bind' },
      })
    ).id;
    await putSecret(tx, provider, 'target.entra.bind', 'old-secret');
  });
});

const outbox = () => withTenant(tenantId, (tx) => tx.notificationOutbox.findMany({ orderBy: { createdAt: 'asc' } }));
const actions = () =>
  withTenant(tenantId, async (tx) => (await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } })).map((e) => e.action));

describe('the inventory', () => {
  it('lists connector secrets, signing keys, certificates, tokens and webhook secrets with their expiry source', async () => {
    const saml = await ensureActiveKey(tenantId, provider, 'saml', { now });
    await withTenant(tenantId, async (tx) => {
      await tx.upstreamIdp.create({
        data: { tenantId, slug: 'corp', name: 'Corporate IdP', protocol: 'saml', idpCertificates: [saml.certificate!, 'not a certificate'] },
      });
      await issueApiToken(tx, { userId: owner, name: 'SCIM from Workday', scopes: [], expiresAt: new Date(now.getTime() + 10 * DAY), createdBy: admin });
      await tx.webhookEndpoint.create({ data: { tenantId, name: 'SIEM', url: 'https://siem.example/hook' } });
    });

    const { items, alertDays } = await withTenant(tenantId, (tx) => buildCredentialInventory(tx, now));
    expect(alertDays).toEqual([30, 14, 7, 1]);
    const byKind = (kind: string) => items.filter((i) => i.kind === kind);

    const target = byKind('target_secret')[0]!;
    expect(target).toMatchObject({ key: credentialKey('target_secret', targetId), label: 'Entra ID client secret', status: 'unknown', expirySource: 'unknown' });
    expect(target.lastRotatedAt).toBeInstanceOf(Date);
    expect(target.rotation).toEqual({ systemKind: 'target', systemId: targetId });

    const certs = byKind('upstream_certificate');
    expect(certs).toHaveLength(2);
    expect(certs.find((c) => c.expirySource === 'certificate')!.expiresAt!.getTime()).toBe(saml.notAfter.getTime());
    expect(certs.find((c) => c.expirySource === 'unknown')!.label).toMatch(/unreadable/);

    expect(byKind('signing_key')[0]).toMatchObject({ expirySource: 'issued', status: 'ok', alertable: true });
    expect(byKind('api_token')[0]).toMatchObject({ status: 'expiring', daysRemaining: 10, ownerUserId: admin, ownerName: 'Admin' });
    expect(byKind('webhook_secret')[0]).toMatchObject({ status: 'no_expiry', expirySource: 'none' });

    // Never a secret, and never a vault name.
    const text = JSON.stringify(items);
    expect(text).not.toContain('old-secret');
    expect(text).not.toContain('target.entra.bind');
    // The expiring token sorts first.
    expect(items[0]!.kind).toBe('api_token');
  });

  it('takes a declared expiry for a connector secret and refuses one for a certificate-bearing credential', async () => {
    const key = credentialKey('target_secret', targetId);
    const view = await withTenant(tenantId, (tx) =>
      updateCredentialMetadata(tx, admin, key, { ownerUserId: owner, declaredExpiresAt: new Date(now.getTime() + 20 * DAY), note: 'Rotate with IAM team' }, now),
    );
    expect(view).toMatchObject({ expirySource: 'declared', status: 'expiring', ownerName: 'Owner', note: 'Rotate with IAM team' });

    const saml = await ensureActiveKey(tenantId, provider, 'saml', { now });
    const keyRow = await withTenant(tenantId, (tx) => tx.signingKey.findFirstOrThrow({ where: { kid: saml.kid } }));
    await expect(
      withTenant(tenantId, (tx) => updateCredentialMetadata(tx, admin, credentialKey('signing_key', keyRow.id), { declaredExpiresAt: now }, now)),
    ).rejects.toMatchObject({ code: 'not_declarable' });
    expect(await actions()).toContain('credential.metadata_updated');
  });

  it('computes status and alert stages at the boundaries', () => {
    const days = [30, 14, 7, 1];
    expect(statusFor(null, 'none', now, days).status).toBe('no_expiry');
    expect(statusFor(null, 'unknown', now, days).status).toBe('unknown');
    expect(statusFor(new Date(now.getTime() - 1), 'issued', now, days).status).toBe('expired');
    expect(statusFor(new Date(now.getTime() + 31 * DAY), 'issued', now, days).status).toBe('ok');
    expect(alertStage(new Date(now.getTime() + 31 * DAY), now, days)).toBeNull();
    expect(alertStage(new Date(now.getTime() + 30 * DAY), now, days)).toBe(30);
    expect(alertStage(new Date(now.getTime() + 3 * DAY), now, days)).toBe(7);
    expect(alertStage(now, now, days)).toBe(0);
  });
});

describe('the expiry scan', () => {
  const noDiscovery = { discover: async () => ({ status: 'not_permitted' as const, message: 'no consent' }) };

  it('raises the most urgent threshold once, again at the next, then on expiry, and lists the expiry as an incident', async () => {
    await withTenant(tenantId, (tx) =>
      issueApiToken(tx, { userId: owner, name: 'HR feed', scopes: [], expiresAt: new Date(now.getTime() + 5 * DAY), createdBy: null }),
    );

    const first = await scanCredentials(tenantId, provider, { now, ...noDiscovery });
    expect(first.alertsRaised).toBe(1);
    // No owner: the tenant.manage holders are told, so somebody always is.
    let mail = await outbox();
    expect(mail.map((m) => [m.template, m.to])).toEqual([['security-credential-expiring', 'admin@acme.test']]);
    expect(mail[0]!.vars).toMatchObject({ daysRemaining: '5', subjectName: 'owner' });

    // The same day again: nothing new.
    expect((await scanCredentials(tenantId, provider, { now: new Date(now.getTime() + 3_600_000), ...noDiscovery })).alertsRaised).toBe(0);

    // Inside the one-day threshold.
    const later = new Date(now.getTime() + 4.5 * DAY);
    expect((await scanCredentials(tenantId, provider, { now: later, ...noDiscovery })).alertsRaised).toBe(1);

    // Expired.
    const after = new Date(now.getTime() + 6 * DAY);
    expect((await scanCredentials(tenantId, provider, { now: after, ...noDiscovery })).alertsRaised).toBe(1);
    mail = await outbox();
    expect(mail.map((m) => m.template)).toEqual([
      'security-credential-expiring',
      'security-credential-expiring',
      'security-credential-expired',
    ]);
    expect((await actions()).filter((a) => a.startsWith('credential.'))).toEqual([
      'credential.expiring',
      'credential.expiring',
      'credential.expired',
    ]);
    const incidents = await withTenant(tenantId, (tx) => listIncidents(tx, after));
    expect(incidents).toContainEqual(expect.objectContaining({ kind: 'credential_expired', count: 1, severity: 'critical' }));
    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toMatchObject({ valid: true });
  });

  it('tells the owner, and administrators only when the tenant asked for it', async () => {
    const key = credentialKey('target_secret', targetId);
    await withTenant(tenantId, (tx) =>
      updateCredentialMetadata(tx, admin, key, { ownerUserId: owner, declaredExpiresAt: new Date(now.getTime() + 10 * DAY) }, now),
    );
    await scanCredentials(tenantId, provider, { now, ...noDiscovery });
    expect((await outbox()).map((m) => m.to)).toEqual(['owner@acme.test']);

    await withTenant(tenantId, (tx) => updateSecurityNotificationSettings(tx, admin, { emailCategories: ['credential_expiry'] }));
    await scanCredentials(tenantId, provider, { now: new Date(now.getTime() + 4 * DAY), ...noDiscovery });
    expect((await outbox()).slice(1).map((m) => m.to).sort()).toEqual(['admin@acme.test', 'owner@acme.test']);
  });

  it('uses a discovered Entra expiry, and backs off for a week after a refusal', async () => {
    let calls = 0;
    const found = await scanCredentials(tenantId, provider, {
      now,
      discover: async (config) => {
        calls += 1;
        expect(config.bindPassword).toBe('old-secret');
        return { status: 'found', expiresAt: new Date(now.getTime() + 12 * DAY).toISOString(), others: [], ambiguous: false };
      },
    });
    expect(found.discovered).toBe(1);
    const item = (await withTenant(tenantId, (tx) => buildCredentialInventory(tx, now))).items.find((i) => i.kind === 'target_secret')!;
    expect(item).toMatchObject({ expirySource: 'discovered', daysRemaining: 12, status: 'expiring' });

    const refuse = async () => {
      calls += 1;
      return { status: 'not_permitted' as const, message: 'no consent' };
    };
    await scanCredentials(tenantId, provider, { now, discover: refuse });
    await scanCredentials(tenantId, provider, { now: new Date(now.getTime() + DAY), discover: refuse });
    expect(calls).toBe(2);
    await scanCredentials(tenantId, provider, { now: new Date(now.getTime() + DAY), discover: refuse, forceDiscovery: true });
    expect(calls).toBe(3);
    await scanCredentials(tenantId, provider, { now: new Date(now.getTime() + 9 * DAY), discover: refuse });
    expect(calls).toBe(4);
  });
});

describe('the rotation workflow', () => {
  const tester = (ok: (secret: string) => boolean): RotationTester => async (_system, secret) =>
    ok(secret) ? { ok: true, message: 'reachable' } : { ok: false, message: 'credential refused: AADSTS7000215' };
  const liveSecret = () => withTenant(tenantId, (tx) => getSecret(tx, provider, 'target.entra.bind'));

  it('stages, verifies, cuts over with the old secret kept, and completes only after the live secret passes', async () => {
    const staged = await stageRotation(tenantId, provider, admin, {
      systemKind: 'target', systemId: targetId, secret: 'new-secret', newExpiresAt: new Date(now.getTime() + 180 * DAY),
    }, { now });
    expect(staged.status).toBe('staged');
    expect(await liveSecret()).toBe('old-secret');

    await expect(stageRotation(tenantId, provider, admin, { systemKind: 'target', systemId: targetId, secret: 'x' }))
      .rejects.toMatchObject({ code: 'already_open' });
    await expect(cutOverRotation(tenantId, provider, admin, staged.id, { now })).rejects.toMatchObject({ code: 'not_verified' });

    const failed = await verifyRotation(tenantId, provider, admin, staged.id, { now, tester: tester(() => false) });
    expect(failed).toMatchObject({ status: 'verification_failed', verificationOk: false });
    await expect(cutOverRotation(tenantId, provider, admin, staged.id, { now })).rejects.toBeInstanceOf(RotationRefusedError);

    const verified = await verifyRotation(tenantId, provider, admin, staged.id, { now, tester: tester((s) => s === 'new-secret') });
    expect(verified.status).toBe('verified');

    const cut = await cutOverRotation(tenantId, provider, admin, staged.id, { now });
    expect(cut).toMatchObject({ status: 'cut_over', overlapActive: true });
    expect(await liveSecret()).toBe('new-secret');
    const held = await withTenant(tenantId, (tx) => tx.secret.findMany({ where: { name: { startsWith: 'credential-rotation.' } } }));
    expect(held.map((s) => s.name)).toEqual([`credential-rotation.${staged.id}.previous`]);

    // The declared expiry of the new secret is now the inventory's.
    const item = (await withTenant(tenantId, (tx) => buildCredentialInventory(tx, now))).items.find((i) => i.kind === 'target_secret')!;
    expect(item).toMatchObject({ expirySource: 'declared', daysRemaining: 180 });

    await expect(completeRotation(tenantId, provider, admin, staged.id, { now, tester: tester(() => false) }))
      .rejects.toMatchObject({ code: 'check_failed' });
    expect(await withTenant(tenantId, (tx) => tx.secret.count({ where: { name: { startsWith: 'credential-rotation.' } } }))).toBe(1);

    const done = await completeRotation(tenantId, provider, admin, staged.id, { now, tester: tester((s) => s === 'new-secret') });
    expect(done).toMatchObject({ status: 'completed', overlapActive: false });
    expect(await withTenant(tenantId, (tx) => tx.secret.count({ where: { name: { startsWith: 'credential-rotation.' } } }))).toBe(0);
    expect(done.evidence.map((e) => e.step)).toEqual([
      'staged', 'verified', 'verified', 'cut_over', 'post_cut_over_check', 'completed',
    ]);
    expect(JSON.stringify(done)).not.toContain('new-secret');

    const readiness = await withTenant(tenantId, (tx) => tx.connectionReadinessCheck.findMany({ orderBy: { checkedAt: 'asc' } }));
    expect(readiness.at(-1)).toMatchObject({ systemKind: 'target', systemId: targetId, status: 'passed' });
    expect((await actions()).filter((a) => a.startsWith('credential.rotation'))).toEqual([
      'credential.rotation_staged',
      'credential.rotation_verified',
      'credential.rotation_verified',
      'credential.rotation_cut_over',
      'credential.rotation_completed',
      'credential.rotation_completed',
    ]);
    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toMatchObject({ valid: true });
  });

  it('rolls back to the previous secret, and cancels a staged one without touching the live secret', async () => {
    const r = await stageRotation(tenantId, provider, admin, { systemKind: 'target', systemId: targetId, secret: 'new-secret' }, { now });
    await verifyRotation(tenantId, provider, admin, r.id, { now, tester: tester(() => true) });
    await cutOverRotation(tenantId, provider, admin, r.id, { now });
    const back = await rollbackRotation(tenantId, provider, admin, r.id, { now });
    expect(back.status).toBe('rolled_back');
    expect(await liveSecret()).toBe('old-secret');

    const c = await stageRotation(tenantId, provider, admin, { systemKind: 'target', systemId: targetId, secret: 'other' }, { now });
    expect((await cancelRotation(tenantId, admin, c.id, { now })).status).toBe('cancelled');
    expect(await liveSecret()).toBe('old-secret');
    expect(await withTenant(tenantId, (tx) => tx.secret.count({ where: { name: { startsWith: 'credential-rotation.' } } }))).toBe(0);
  });

  it('refuses a cut-over when the configuration changed after the test, or the test is stale', async () => {
    const r = await stageRotation(tenantId, provider, admin, { systemKind: 'target', systemId: targetId, secret: 'new-secret' }, { now });
    await verifyRotation(tenantId, provider, admin, r.id, { now, tester: tester(() => true) });
    await expect(cutOverRotation(tenantId, provider, admin, r.id, { now: new Date(now.getTime() + 2 * DAY) }))
      .rejects.toMatchObject({ code: 'verification_stale' });
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { config: { tenantId: 'evil.example', clientId: 'app-1' } } }),
    );
    await expect(cutOverRotation(tenantId, provider, admin, r.id, { now })).rejects.toMatchObject({ code: 'configuration_changed' });
    expect(await liveSecret()).toBe('old-secret');
  });
});

describe('the security notification policy', () => {
  const assigned = (roleId: string, actorUserId = admin) =>
    withTenant(tenantId, (tx) =>
      recordEvent(tx, { actorUserId, action: 'rbac.role_assigned', targetType: 'User', targetId: owner, outcome: 'success', sourceIp: null, payload: { roleId } }),
    );

  it('mails tenant.manage holders only for an opted-in category, and only for a privileged grant', async () => {
    const privileged = await withTenant(tenantId, (tx) => createRole(tx, 'Provisioning', [PERMISSIONS.PROVISION_MANAGE]));
    const plain = await withTenant(tenantId, (tx) => createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]));

    await assigned(privileged.id);
    expect(await outbox()).toHaveLength(0);

    await withTenant(tenantId, (tx) => updateSecurityNotificationSettings(tx, admin, { emailCategories: ['privileged_role_grants'] }));
    await assigned(plain.id);
    expect(await outbox()).toHaveLength(0);
    await assigned(privileged.id);
    const mail = await outbox();
    expect(mail.map((m) => [m.template, m.to, m.digest])).toEqual([['security-event', 'admin@acme.test', false]]);
    expect(mail[0]!.vars).toMatchObject({ action: 'rbac.role_assigned', categoryLabel: 'Privileged role grants' });
    // No audit payload reaches the mail.
    expect(JSON.stringify(mail[0]!.vars)).not.toContain(privileged.id);
  });

  it('treats an administrator removing a factor as suspicious and a person removing their own as housekeeping', async () => {
    await withTenant(tenantId, (tx) => updateSecurityNotificationSettings(tx, admin, { emailCategories: ['suspicious_authentication'] }));
    const removed = (by: string) =>
      withTenant(tenantId, (tx) =>
        recordEvent(tx, { actorUserId: owner, action: 'mfa.removed', targetType: 'User', targetId: owner, outcome: 'success', sourceIp: null, payload: { factor: 'totp', by } }),
      );
    await removed('self');
    expect(await outbox()).toHaveLength(0);
    await removed('administrator');
    expect(await outbox()).toHaveLength(1);
  });

  it('is refused by the database for an unknown category', async () => {
    await expect(
      withTenant(tenantId, (tx) => tx.tenant.update({ where: { id: tenantId }, data: { securityEmailCategories: ['everything'] } })),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantId, (tx) => tx.tenant.update({ where: { id: tenantId }, data: { credentialAlertDays: [0] } })),
    ).rejects.toThrow();
  });
});
