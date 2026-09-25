import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { getSecret } from '../vault/vault-service.js';
import { memoryTransport } from '../notify/notification-service.js';
import { notificationsSettled } from '../notify/delivery.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun } from './apply.js';
import {
  CREDENTIAL_PICKUP_LIFETIME_MS,
  NoDeliveryAddressError,
  NoInitialSecretError,
  credentialPickupHistory,
  credentialPickupStatus,
  revealCredentialPickup,
  sendCredentialPickup,
} from './credential-pickup.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const USERS = 'OU=Users,DC=acme,DC=test';
const NOW = new Date('2026-06-15T00:00:00Z');
const PUBLIC_URL = 'https://idm.acme.test';
const noSleep = async () => undefined;

let tenantId: string;
let targetId: string;
let personId: string;
let adminId: string;
let target: FakeTarget;
let mail: ReturnType<typeof memoryTransport>;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: USERS,
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

const profile = (overrides: Record<string, unknown> = {}) =>
  upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: USERS,
    fallbackContainer: USERS,
    attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'personalEmail',
    ...overrides,
  });

beforeEach(async () => {
  await resetDatabase();
  mail = memoryTransport();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  targetId = (
    await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    })
  ).id;
  target = new FakeTarget();
  target.containers.push(USERS);

  ({ personId, adminId } = await withTenant(tenantId, async (tx) => {
    const manager = await tx.person.create({
      data: { tenantId, givenName: 'Mara', familyName: 'Boss', businessEmail: 'mara.boss@acme.test' },
    });
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak', personalEmail: 'anna@home.test' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01T00:00:00Z'),
        department: 'Finance',
        managerPersonId: manager.id,
      },
    });
    const admin = await tx.user.create({
      data: { tenantId, login: 'admin', email: 'admin@acme.test', displayName: 'Admin' },
    });
    return { personId: person.id, adminId: admin.id };
  }));

  await profile();
  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [],
  });
});

/** Previews and applies, with the transport and public URL a real apply is given. */
async function provision(options: { publicUrl?: string } = { publicUrl: PUBLIC_URL }) {
  const run = await previewProvisionRun(tenantId, provider, targetId, {
    now: NOW,
    connector: target as never,
  });
  await applyProvisionRun(tenantId, provider, run.id, {
    confirm: true,
    confirmedByUserId: adminId,
    connector: target as never,
    now: NOW,
    sleep: noSleep,
    transport: mail,
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
  });
  await notificationsSettled();
}

const accountOf = () =>
  withTenant(tenantId, (tx) => tx.targetAccount.findFirstOrThrow({ where: { personId } }));

const passwordOf = async () => {
  const account = await accountOf();
  return withTenant(tenantId, (tx) =>
    getSecret(tx, provider, `target/${targetId}/initial/${account.id}`),
  );
};

const tokenFrom = (text: string) => {
  const match = /\/credential\/([A-Za-z0-9_-]+)/.exec(text);
  return match![1]!;
};

const pickups = () => withTenant(tenantId, (tx) => tx.credentialPickup.findMany({ orderBy: { createdAt: 'asc' } }));
const auditCount = () => withTenant(tenantId, (tx) => tx.auditEvent.count());

describe('minting on create', () => {
  it('mails a one-time link, and never the password, to the configured recipient', async () => {
    await provision();

    const password = await passwordOf();
    expect(password).not.toBeNull();
    expect(mail.sent).toHaveLength(1);
    const [message] = mail.sent;
    expect(message!.to).toBe('anna@home.test');
    // The whole message, every part of it: no password anywhere.
    expect(JSON.stringify(message)).not.toContain(password!);
    expect(message!.text).toContain(`${PUBLIC_URL}/credential/`);
    expect(message!.text).toContain('Acme AD');
    expect(message!.text).toContain('anna.novak');
    expect(message!.subject).toContain('Acme');

    // Stored as a hash, 72 hours out, pointing at the sealed secret.
    const token = tokenFrom(message!.text);
    const [row] = await pickups();
    expect(row!.tokenHash).not.toContain(token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.recipientKind).toBe('personalEmail');
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(CREDENTIAL_PICKUP_LIFETIME_MS);
    expect(JSON.stringify(row)).not.toContain('anna@home.test');

    // And nothing in the audit trail carries the password or the token.
    const events = await withTenant(tenantId, (tx) => tx.auditEvent.findMany());
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(password!);
    expect(serialised).not.toContain(token);
  });

  it('promises a forced change at first sign-in only when the target will ask', async () => {
    await provision();
    expect(mail.sent[0]!.text).toContain('You will be asked to choose a new password when you first sign in.');
    // The AD connector was told to set pwdLastSet = 0.
    const create = target.calls.find((op) => op.op === 'create_account');
    expect(create).toMatchObject({ requirePasswordChange: true });
  });

  it('tells them to change it themselves when the profile turned the forced change off', async () => {
    await profile({ requirePasswordChangeAtFirstSignIn: false });
    await provision();
    expect(mail.sent[0]!.text).toContain('Change it after you sign in.');
    expect(mail.sent[0]!.text).not.toContain('asked to choose');
    expect(target.calls.find((op) => op.op === 'create_account')).toMatchObject({
      requirePasswordChange: false,
    });
  });

  it('addresses the manager as somebody passing the details on', async () => {
    await profile({ initialPasswordDelivery: 'manager' });
    await provision();
    expect(mail.sent[0]!.to).toBe('mara.boss@acme.test');
    expect(mail.sent[0]!.text).toContain('Anna Novak');
    expect((await pickups())[0]!.recipientKind).toBe('manager');
  });

  it('keeps vaultOnly exactly as it was: sealed, no link, nothing sent', async () => {
    await profile({ initialPasswordDelivery: 'vaultOnly' });
    await provision();
    expect(await passwordOf()).not.toBeNull();
    expect(mail.sent).toHaveLength(0);
    expect(await pickups()).toHaveLength(0);
  });

  it('sends nothing, and says why, when the apply was given no public URL', async () => {
    await provision({});
    expect(mail.sent).toHaveLength(0);
    expect(await pickups()).toHaveLength(0);
    const sealed = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'provision.credential.sealed' } }),
    );
    expect((sealed.payload as { note: string }).note).toMatch(/no public URL/);
  });
});

describe('the pickup', () => {
  it('reads the state without changing anything', async () => {
    await provision();
    const token = tokenFrom(mail.sent[0]!.text);
    const before = await auditCount();

    // A mail scanner opening the link, twice.
    for (let i = 0; i < 2; i += 1) {
      const status = await credentialPickupStatus(tenantId, token, NOW);
      expect(status).toMatchObject({ state: 'ready', systemName: 'Acme AD', username: 'anna.novak' });
      expect(status).not.toHaveProperty('password');
    }
    expect((await pickups())[0]!.viewedAt).toBeNull();
    expect(await auditCount()).toBe(before);
  });

  it('reveals the sealed password once, and refuses the second time', async () => {
    await provision();
    const token = tokenFrom(mail.sent[0]!.text);

    const first = await revealCredentialPickup(tenantId, provider, token, { sourceIp: '198.51.100.7', now: NOW });
    expect(first).toEqual({
      ok: true,
      username: 'anna.novak',
      systemName: 'Acme AD',
      password: await passwordOf(),
    });
    const second = await revealCredentialPickup(tenantId, provider, token, { sourceIp: null, now: NOW });
    expect(second).toEqual({ ok: false });
    expect((await credentialPickupStatus(tenantId, token, NOW))!.state).toBe('used');

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: 'provision.credential.picked_up' },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(events.map((e) => [e.outcome, (e.payload as { reason?: string }).reason])).toEqual([
      ['success', undefined],
      ['failure', 'used'],
    ]);
    expect(JSON.stringify(events)).not.toContain((await passwordOf())!);
  });

  it('lets exactly one of two concurrent reveals have the password', async () => {
    await provision();
    const token = tokenFrom(mail.sent[0]!.text);

    const outcomes = await Promise.all([
      revealCredentialPickup(tenantId, provider, token, { sourceIp: null, now: NOW }),
      revealCredentialPickup(tenantId, provider, token, { sourceIp: null, now: NOW }),
      revealCredentialPickup(tenantId, provider, token, { sourceIp: null, now: NOW }),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
  });

  it('refuses an expired link and says it expired', async () => {
    await provision();
    const token = tokenFrom(mail.sent[0]!.text);
    const later = new Date(Date.now() + CREDENTIAL_PICKUP_LIFETIME_MS + 1000);

    expect((await credentialPickupStatus(tenantId, token, later))!.state).toBe('expired');
    expect(await revealCredentialPickup(tenantId, provider, token, { sourceIp: null, now: later })).toEqual({
      ok: false,
    });
    expect((await pickups())[0]!.viewedAt).toBeNull();
  });

  it('refuses a token that matches nothing, and reads null for it', async () => {
    expect(await credentialPickupStatus(tenantId, 'x'.repeat(43))).toBeNull();
    expect(await revealCredentialPickup(tenantId, provider, 'x'.repeat(43), { sourceIp: null })).toEqual({
      ok: false,
    });
  });
});

describe('sending again', () => {
  const resend = (recipient: 'profile' | 'personalEmail' | 'manager' | 'admin') =>
    sendCredentialPickup(tenantId, mail, PUBLIC_URL, {
      targetSystemId: targetId,
      personId,
      recipient,
      actorUserId: adminId,
      sourceIp: '198.51.100.9',
    });

  it('revokes the unopened link and sends a new one that works', async () => {
    await provision();
    const oldToken = tokenFrom(mail.sent[0]!.text);

    const result = await resend('manager');
    expect(result).toMatchObject({ recipientKind: 'manager', revoked: 1, delivered: true });
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1]!.to).toBe('mara.boss@acme.test');
    expect(JSON.stringify(mail.sent[1])).not.toContain((await passwordOf())!);

    expect((await credentialPickupStatus(tenantId, oldToken))!.state).toBe('revoked');
    expect((await revealCredentialPickup(tenantId, provider, oldToken, { sourceIp: null })).ok).toBe(false);

    const newToken = tokenFrom(mail.sent[1]!.text);
    expect((await revealCredentialPickup(tenantId, provider, newToken, { sourceIp: null })).ok).toBe(true);

    const history = await withTenant(tenantId, (tx) => credentialPickupHistory(tx, targetId, personId));
    expect(history!.hasInitialSecret).toBe(true);
    expect(history!.pickups.map((p) => p.state)).toEqual(['used', 'revoked']);

    const sent = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'provision.credential.link_sent' } }),
    );
    expect(sent.actorUserId).toBe(adminId);
    expect(JSON.stringify(sent.payload)).not.toContain('mara.boss@acme.test');
  });

  it("sends to the administrator's own address when asked", async () => {
    await provision();
    await resend('admin');
    expect(mail.sent[1]!.to).toBe('admin@acme.test');
  });

  it('refuses, and revokes nothing, when there is no initial password to link to', async () => {
    await provision();
    const account = await accountOf();
    await withTenant(tenantId, (tx) =>
      tx.secret.deleteMany({ where: { name: `target/${targetId}/initial/${account.id}` } }),
    );
    await expect(resend('profile')).rejects.toBeInstanceOf(NoInitialSecretError);
    expect((await pickups()).every((p) => p.revokedAt === null)).toBe(true);
  });

  it('refuses the profile recipient when the profile sends to nobody', async () => {
    await provision();
    await profile({ initialPasswordDelivery: 'vaultOnly' });
    await expect(resend('profile')).rejects.toBeInstanceOf(NoDeliveryAddressError);
  });
});
