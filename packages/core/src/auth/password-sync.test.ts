import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adPasswordReset, entraPasswordReset } from '@syntra/connectors';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase, verifyTestEmailDomains } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createTarget, LadderConfigurationError, updateTarget } from '../provision/target-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createSession, resolveSession } from './session-service.js';
import { hashPassword, setPasswordHash, verifyPassword } from './password.js';
import { changeOwnPassword, setPasswordAsAdmin } from './password-change.js';
import { completePasswordReset, requestPasswordReset } from './password-reset.js';
import { memoryTransport } from '../notify/notification-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 21));

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';
const PASSWORD_HASH = await hashPassword(PASSWORD);

const AD_CONFIG = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

const ENTRA_CONFIG = {
  tenantId: '99999999-8888-7777-6666-555555555555',
  clientId: 'client',
  graphBaseUrl: 'https://graph.invalid/v1.0',
  tokenUrl: 'https://login.invalid/token',
};

let tenantId: string;
let userId: string;
let personId: string;
let adId: string;
let entraId: string;

const ok = { ok: true, message: 'password set' } as const;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  await verifyTestEmailDomains(t.id);
  tenantId = t.id;

  adId = (await createTarget(tenantId, provider, null, {
    type: 'activeDirectory',
    name: 'Acme AD',
    config: AD_CONFIG,
    bindPassword: 'ad-secret',
  })).id;
  entraId = (await createTarget(tenantId, provider, null, {
    type: 'entraId',
    name: 'Acme Entra',
    config: ENTRA_CONFIG,
    bindPassword: 'entra-secret',
  })).id;
  await updateTarget(tenantId, provider, null, adId, { syncPassword: true });
  await updateTarget(tenantId, provider, null, entraId, { syncPassword: true });

  await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Jo', familyName: 'Doe' },
    });
    personId = person.id;
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'jo.doe@acme.test',
      displayName: 'Jo Doe',
    });
    await tx.user.update({ where: { id: user.id }, data: { personId } });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    userId = user.id;
    for (const [targetSystemId, anchor] of [
      [adId, 'ad-anchor'],
      [entraId, 'entra-anchor'],
    ] as const) {
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId,
          personId,
          anchor,
          correlationKey: 'jo.doe',
          status: 'active',
        },
      });
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function change(newPassword = NEW_PASSWORD) {
  const sessionId = await withTenant(tenantId, async (tx) => {
    const created = await createSession(tx, {
      status: 'allow',
      userId,
      scope: 'portal',
      satisfiedFactor: null,
      mayElevate: false,
      applicationId: null,
    }, { ip: null, userAgent: null });
    return (await resolveSession(tx, created.token))!.sessionId;
  });
  return changeOwnPassword(tenantId, provider, {
    userId,
    currentPassword: PASSWORD,
    newPassword,
    sessionId,
    sourceIp: '10.1.2.3',
  });
}

const storedHash = async () =>
  (await withTenant(tenantId, (tx) =>
    tx.passwordCredential.findUniqueOrThrow({ where: { userId } }),
  )).hash;

const syncEvents = () =>
  withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({
      where: { action: { startsWith: 'auth.password_sync' } },
      orderBy: { sequence: 'asc' },
    }),
  );

describe('password sync to targets', () => {
  it('writes Active Directory first, then Entra ID, with the new password', async () => {
    const order: string[] = [];
    const ad = vi.spyOn(adPasswordReset, 'resetPassword').mockImplementation(async (config, input) => {
      order.push(`ad:${input.anchor}`);
      expect((config as { bindPassword: string }).bindPassword).toBe('ad-secret');
      return ok;
    });
    const entra = vi.spyOn(entraPasswordReset, 'resetPassword').mockImplementation(async (_c, input) => {
      order.push(`entra:${input.anchor}`);
      return ok;
    });

    const outcome = await change();

    expect(outcome).toMatchObject({
      ok: true,
      targets: [
        { targetName: 'Acme AD', result: 'synced' },
        { targetName: 'Acme Entra', result: 'synced' },
      ],
    });
    expect(order).toEqual(['ad:ad-anchor', 'entra:entra-anchor']);
    expect(ad.mock.calls[0]![1]).toEqual({ anchor: 'ad-anchor', newPassword: NEW_PASSWORD, requireChange: false });
    expect(entra).toHaveBeenCalledTimes(1);
    expect(await verifyPassword(await storedHash(), NEW_PASSWORD)).toBe(true);

    const events = await syncEvents();
    expect(events.map((e) => e.action)).toEqual(['auth.password_synced', 'auth.password_synced']);
    expect(JSON.stringify(events)).not.toContain(NEW_PASSWORD);
    expect(events[0]!.payload).toMatchObject({ targetSystemId: adId, personId, trigger: 'change' });
  });

  it('changes nothing when the first target refuses the password', async () => {
    vi.spyOn(adPasswordReset, 'resetPassword').mockResolvedValue({
      ok: false,
      failure: 'policy',
      message: 'the directory refused the new password: it does not meet the domain password policy',
    });
    const entra = vi.spyOn(entraPasswordReset, 'resetPassword').mockResolvedValue(ok);

    const outcome = await change();

    expect(outcome).toEqual({
      ok: false,
      reason: 'target_policy',
      message: 'Target "Acme AD" refused the new password. Choose another password.',
    });
    expect(entra).not.toHaveBeenCalled();
    expect(await storedHash()).toBe(PASSWORD_HASH);
  });

  it('commits and reports a refusal that comes after a target accepted', async () => {
    vi.spyOn(adPasswordReset, 'resetPassword').mockResolvedValue(ok);
    vi.spyOn(entraPasswordReset, 'resetPassword').mockResolvedValue({
      ok: false,
      failure: 'policy',
      message: 'Microsoft Entra ID refused the new password: it does not meet the tenant password policy',
    });

    const outcome = await change();

    expect(outcome).toMatchObject({
      ok: true,
      targets: [
        { result: 'synced' },
        {
          result: 'failed',
          message:
            'Password not updated on Target "Acme Entra": Microsoft Entra ID refused the new password: it does not meet the tenant password policy.',
        },
      ],
    });
    expect(await verifyPassword(await storedHash(), NEW_PASSWORD)).toBe(true);
    expect((await syncEvents()).map((e) => e.action)).toEqual([
      'auth.password_synced',
      'auth.password_sync_failed',
    ]);
  });

  it('commits when a target cannot be reached', async () => {
    vi.spyOn(adPasswordReset, 'resetPassword').mockResolvedValue({
      ok: false,
      failure: 'transient',
      message: 'the directory could not be reached',
    });
    vi.spyOn(entraPasswordReset, 'resetPassword').mockResolvedValue(ok);

    const outcome = await change();

    expect(outcome).toMatchObject({ ok: true, targets: [{ result: 'failed' }, { result: 'synced' }] });
    expect(await verifyPassword(await storedHash(), NEW_PASSWORD)).toBe(true);
  });

  it('reports an Entra ID user synced from on-premises AD as skipped', async () => {
    vi.spyOn(adPasswordReset, 'resetPassword').mockResolvedValue(ok);
    vi.spyOn(entraPasswordReset, 'resetPassword').mockResolvedValue({
      ok: false,
      failure: 'unsupported',
      message: 'account is synced from on-premises Active Directory',
    });

    const outcome = await change();

    expect(outcome).toMatchObject({
      ok: true,
      targets: [
        { result: 'synced' },
        {
          result: 'skipped',
          message: 'Skipped Target "Acme Entra": account is synced from on-premises Active Directory.',
        },
      ],
    });
  });

  it('leaves a target with sync off, and an archived account, alone', async () => {
    await updateTarget(tenantId, provider, null, entraId, { syncPassword: false });
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.updateMany({ where: { targetSystemId: adId }, data: { status: 'archived' } }),
    );
    const ad = vi.spyOn(adPasswordReset, 'resetPassword').mockResolvedValue(ok);
    const entra = vi.spyOn(entraPasswordReset, 'resetPassword').mockResolvedValue(ok);

    expect(await change()).toMatchObject({ ok: true, targets: [] });
    expect(ad).not.toHaveBeenCalled();
    expect(entra).not.toHaveBeenCalled();
  });

  it('skips a target whose external writes are paused', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: adId },
        data: { externalWritesPausedAt: new Date(), externalWritesPauseReason: 'incident' },
      }),
    );
    const ad = vi.spyOn(adPasswordReset, 'resetPassword').mockResolvedValue(ok);
    vi.spyOn(entraPasswordReset, 'resetPassword').mockResolvedValue(ok);

    const outcome = await change();

    expect(ad).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      ok: true,
      targets: [
        { result: 'skipped', message: 'Skipped: external writes are paused on Target "Acme AD".' },
        { result: 'synced' },
      ],
    });
  });

  it('asks targets for a change at next sign-in when an administrator sets it', async () => {
    const ad = vi.spyOn(adPasswordReset, 'resetPassword').mockResolvedValue(ok);
    const entra = vi.spyOn(entraPasswordReset, 'resetPassword').mockResolvedValue(ok);

    const outcome = await setPasswordAsAdmin(tenantId, provider, {
      userId,
      actorUserId: userId,
      newPassword: NEW_PASSWORD,
      sourceIp: null,
    });

    expect(outcome).toMatchObject({ ok: true, mustChange: true });
    expect(ad.mock.calls[0]![1].requireChange).toBe(true);
    expect(entra.mock.calls[0]![1].requireChange).toBe(true);
    expect((await syncEvents())[0]!.payload).toMatchObject({ trigger: 'admin_set' });
  });

  it('writes nothing to targets for a user with no person', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: userId }, data: { personId: null } }),
    );
    const ad = vi.spyOn(adPasswordReset, 'resetPassword').mockResolvedValue(ok);

    expect(await change()).toMatchObject({ ok: true, targets: [] });
    expect(ad).not.toHaveBeenCalled();
  });
});

describe('password sync on a reset', () => {
  it('keeps the link usable when the first target refuses the password', async () => {
    const transport = memoryTransport();
    await requestPasswordReset(tenantId, transport, 'http://acme.syntra.test', {
      login: 'jdoe',
      sourceIp: null,
      floorMs: 1,
    });
    const token = /token=([A-Za-z0-9_-]+)/.exec(transport.sent[0]!.text)![1]!;
    const complete = (newPassword: string) =>
      completePasswordReset(tenantId, transport, provider, {
        token,
        newPassword,
        relyingParty: { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' },
        sourceIp: null,
      });
    vi.spyOn(entraPasswordReset, 'resetPassword').mockResolvedValue(ok);
    vi.spyOn(adPasswordReset, 'resetPassword')
      .mockResolvedValueOnce({ ok: false, failure: 'policy', message: 'refused' })
      .mockResolvedValue(ok);

    expect(await complete(NEW_PASSWORD)).toMatchObject({ ok: false, reason: 'target_policy' });
    expect(await storedHash()).toBe(PASSWORD_HASH);

    const second = 'another long passphrase entirely';
    expect(await complete(second)).toMatchObject({
      ok: true,
      targets: [{ result: 'synced' }, { result: 'synced' }],
    });
    expect(await verifyPassword(await storedHash(), second)).toBe(true);
    expect((await syncEvents()).at(-1)!.payload).toMatchObject({ trigger: 'reset' });
  });
});

describe('syncPassword on a target', () => {
  it('is refused for a type that cannot take a password', async () => {
    const scim = await createTarget(tenantId, provider, null, {
      type: 'scim2',
      name: 'SCIM',
      config: { baseUrl: 'https://scim.acme.test/v2' },
      bindPassword: 'token',
    });
    await expect(
      updateTarget(tenantId, provider, null, scim.id, { syncPassword: true }),
    ).rejects.toBeInstanceOf(LadderConfigurationError);
  });

  it('audits the change as from/to', async () => {
    await updateTarget(tenantId, provider, userId, adId, { syncPassword: false });
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { action: 'provision.target.update' },
        orderBy: { sequence: 'desc' },
      }),
    );
    expect(event!.payload).toMatchObject({ syncPassword: { from: true, to: false } });
  });
});
