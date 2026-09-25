import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createTarget,
  createUser,
  hashPassword,
  issueApiToken,
  localMasterKeyProvider,
  mintCredentialPickup,
  putSecret,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let targetId: string;
let personId: string;
let accountId: string;

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const INITIAL = 'Initial-Pa55word!for-anna';
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  targetId = (
    await createTarget(ctx.tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Acme AD',
      config: {
        url: 'ldaps://dc.acme.test:636',
        tlsMode: 'ldaps',
        rejectUnauthorized: false,
        bindDn: 'CN=svc,DC=acme,DC=test',
        baseDn: 'OU=Users,DC=acme,DC=test',
        entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
        archiveContainer: 'OU=Archive,DC=acme,DC=test',
      },
      bindPassword: 'secret',
    })
  ).id;
  ({ personId, accountId } = await withTenant(ctx.tenantId, async (tx) => {
    const manager = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Mara', familyName: 'Boss', businessEmail: 'mara@acme.test' },
    });
    const person = await tx.person.create({
      data: { tenantId: ctx.tenantId, givenName: 'Anna', familyName: 'Novak', personalEmail: 'anna@home.test' },
    });
    await tx.contract.create({
      data: {
        tenantId: ctx.tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01T00:00:00Z'),
        managerPersonId: manager.id,
      },
    });
    const account = await tx.targetAccount.create({
      data: {
        tenantId: ctx.tenantId,
        targetSystemId: targetId,
        personId: person.id,
        correlationKey: 'anna.novak',
        status: 'active',
        anchor: 'guid-anna',
      },
    });
    await putSecret(tx, provider, `target/${targetId}/initial/${account.id}`, INITIAL);
    return { personId: person.id, accountId: account.id };
  }));
});

const mint = (now?: Date) =>
  withTenant(ctx.tenantId, (tx) =>
    mintCredentialPickup(tx, {
      targetAccountId: accountId,
      secretName: `target/${targetId}/initial/${accountId}`,
      recipientKind: 'personalEmail',
      createdByUserId: null,
      ...(now === undefined ? {} : { now }),
    }),
  );

const status = (token: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/credential-pickup/${token}`, headers: { host: ctx.host } });
const reveal = (token: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/credential-pickup/${token}/reveal`, headers: { host: ctx.host } });

const auditCount = () => withTenant(ctx.tenantId, (tx) => tx.auditEvent.count());

describe('the public pickup routes', () => {
  it('answers the state, never the password, and changes nothing', async () => {
    const { token } = await mint();
    const before = await auditCount();

    for (let i = 0; i < 3; i += 1) {
      const res = await status(token);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toMatchObject({ state: 'ready', systemName: 'Acme AD', username: 'anna.novak' });
      expect(res.body).not.toContain(INITIAL);
    }
    expect(await auditCount()).toBe(before);
    const row = await withTenant(ctx.tenantId, (tx) => tx.credentialPickup.findFirstOrThrow());
    expect(row.viewedAt).toBeNull();
  });

  it('reveals the password once, without caching, then answers 410', async () => {
    const { token } = await mint();

    const first = await reveal(token);
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json()).toEqual({ username: 'anna.novak', password: INITIAL });

    const second = await reveal(token);
    expect(second.statusCode).toBe(410);
    expect(second.json().type).toMatch(/credential-link-unusable$/);
    expect(second.body).not.toContain(INITIAL);

    expect((await status(token)).json().state).toBe('used');
  });

  it('answers every refusal the same way, and a nonsense token with 404 or 400', async () => {
    const expired = await mint(new Date(Date.now() - 73 * 60 * 60 * 1000));
    const res = await reveal(expired.token);
    expect(res.statusCode).toBe(410);
    expect((await status(expired.token)).json().state).toBe('expired');

    const unknown = await reveal('A'.repeat(43));
    expect(unknown.statusCode).toBe(410);
    expect(unknown.json()).toEqual(res.json());
    expect((await status('A'.repeat(43))).statusCode).toBe(404);
    // Not a token shape at all: refused before anything is hashed.
    expect((await status('..%2F..')).statusCode).toBe(400);
  });

  it('never puts the password in the audit trail', async () => {
    const { token } = await mint();
    await reveal(token);
    await reveal(token);
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.credential.picked_up' } }),
    );
    expect(events.map((e) => e.outcome).sort()).toEqual(['failure', 'success']);
    expect(JSON.stringify(events)).not.toContain(INITIAL);
    expect(JSON.stringify(events)).not.toContain(token);
  });
});

describe('Send login info', () => {
  async function seedAdmin(permissions: Permission[]) {
    return withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Admin' });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
      if (permissions.length > 0) {
        const role = await createRole(tx, 'Custom', permissions);
        await assignRole(tx, user.id, role.id);
      }
      return user;
    });
  }

  async function adminCookie() {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'admin', password: PASSWORD },
    });
    const portal = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
      payload: { password: PASSWORD },
    });
    return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
  }

  const send = (headers: Record<string, string>, recipient = 'personalEmail') =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/admin/targets/${targetId}/accounts/${personId}/send-login-info`,
      headers: { host: ctx.host, ...headers },
      payload: { recipient },
    });

  it('revokes the unopened link, mails a new one, and lists both', async () => {
    await seedAdmin([PERMISSIONS.PROVISION_MANAGE, PERMISSIONS.PROVISION_READ]);
    const cookie = await adminCookie();
    const earlier = await mint();

    const res = await send({ cookie }, 'manager');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recipientKind: 'manager', revoked: 1, delivered: true });
    expect(ctx.mail.sent.at(-1)!.to).toBe('mara@acme.test');
    expect(JSON.stringify(ctx.mail.sent)).not.toContain(INITIAL);
    expect((await status(earlier.token)).json().state).toBe('revoked');

    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/targets/${targetId}/accounts/${personId}/credential-pickups`,
      headers: { host: ctx.host, cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().hasInitialSecret).toBe(true);
    expect(history.json().pickups.map((p: { state: string }) => p.state)).toEqual(['ready', 'revoked']);
    expect(history.body).not.toContain(earlier.token);
  });

  it('refuses without provision.manage', async () => {
    await seedAdmin([PERMISSIONS.PROVISION_READ]);
    const cookie = await adminCookie();
    expect((await send({ cookie })).statusCode).toBe(403);
    expect(ctx.mail.sent).toHaveLength(0);
  });

  it('demands a fresh elevation, and records the refusal', async () => {
    await seedAdmin([PERMISSIONS.PROVISION_MANAGE]);
    const cookie = await adminCookie();
    await withTenant(ctx.tenantId, (tx) =>
      tx.session.updateMany({
        where: { scope: 'admin' },
        data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) },
      }),
    );
    const res = await send({ cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toMatch(/step-up-required$/);
    expect(ctx.mail.sent).toHaveLength(0);
    const refusal = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'provision.credential.link_sent', outcome: 'failure' } }),
    );
    expect(refusal.payload).toMatchObject({ reason: 'step_up_required' });
  });

  it('refuses a machine token, whatever it holds', async () => {
    const admin = await seedAdmin([PERMISSIONS.PROVISION_MANAGE]);
    const { token } = await withTenant(ctx.tenantId, (tx) =>
      issueApiToken(tx, { userId: admin.id, name: 'automation', scopes: [], expiresAt: null, createdBy: null }),
    );
    const res = await send({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(403);
    expect(ctx.mail.sent).toHaveLength(0);
  });

  it('answers 409 when there is no initial password to send', async () => {
    await seedAdmin([PERMISSIONS.PROVISION_MANAGE]);
    const cookie = await adminCookie();
    await withTenant(ctx.tenantId, (tx) => tx.secret.deleteMany({ where: { name: { contains: '/initial/' } } }));
    const res = await send({ cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toMatch(/no-initial-secret$/);
  });
});
