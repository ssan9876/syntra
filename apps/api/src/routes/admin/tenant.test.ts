import { beforeEach, describe, expect, it, vi } from 'vitest';
// The NAMESPACE, so `vi.spyOn` has an object to replace the property on. The
// route imports the binding by name; vitest rewrites that to namespace access,
// so the spy sees the call the route actually makes.
import * as protocols from '@syntra/protocols';
import { prisma, withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  generateRecoveryCodes,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'a-long-enough-password';

/**
 * Hashed once for the whole file, outside every transaction.
 *
 * There is no helper that takes a plaintext and a transaction any more:
 * Argon2id is deliberately expensive and has no business inside Prisma's
 * 5000 ms budget, so `setPasswordHash` takes a hash and the hashing is the
 * caller's to place. Hashing once per file rather than once per test is the
 * same decision made cheaply.
 */
const PASSWORD_HASH = await hashPassword(PASSWORD);


async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Custom', permissions);
    await assignRole(tx, user.id, role.id);
    return user;
  });
}

/** Signs in and elevates, returning a Cookie header value. */
async function adminCookie() {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
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

const get = (cookie: string) =>
  ctx.app.inject({
    method: 'GET',
    url: '/api/admin/tenant',
    headers: { host: ctx.host, cookie },
  });

const put = (cookie: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PUT',
    url: '/api/admin/tenant',
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('GET /api/admin/tenant', () => {
  it('needs an administrative session', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/tenant',
      headers: { host: ctx.host },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a caller without tenant.manage', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    expect((await get(await adminCookie())).statusCode).toBe(403);
  });

  it('returns the settings and whether a security key can be registered', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const res = await get(await adminCookie());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      slug: 'acme',
      adminMfaRequired: false,
      selfEnrolmentEnabled: true,
      passwordMinLength: 12,
      // No primary domain on the test tenant, so there is nothing to pin a
      // relying party to and the screen must be able to say so.
      primaryDomain: null,
      webauthnAvailable: false,
    });
  });
});

describe('PUT /api/admin/tenant', () => {
  it('turns admin MFA on, and the elevation endpoint acts on it', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();

    // The elevation that produced this cookie asked for a password only.
    const saved = await put(cookie, { adminMfaRequired: true });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().adminMfaRequired).toBe(true);

    // The next one is the proof: the setting is a floor `authorize()` imposes,
    // and before this route existed the only way to reach it was direct SQL.
    const portal = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'admin', password: PASSWORD },
    });
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: {
        host: ctx.host,
        cookie: `syntra_session=${portal.cookies.find((c) => c.name === 'syntra_session')!.value}`,
      },
      payload: { password: PASSWORD },
    });
    // Not `authenticated`: the floor asks for a factor this administrator does
    // not hold, so they are offered enrolment instead of a console session.
    expect(again.json().status).toBe('enrol');
  });

  it('records the resulting state in the same transaction as the change', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();
    await put(cookie, { selfEnrolmentEnabled: false });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'tenant.settings_updated' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      changed: ['selfEnrolmentEnabled'],
      selfEnrolmentEnabled: false,
      adminMfaRequired: false,
    });
  });

  it('refuses the pair that locks the console from the inside', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();

    const res = await put(cookie, {
      adminMfaRequired: true,
      selfEnrolmentEnabled: false,
    });

    // Required factor plus no self-enrolment refuses everybody who does not
    // already hold one — including the administrator saving the form.
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe(
      'https://syntra.dev/problems/would-lock-you-out',
    );
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    expect(tenant.adminMfaRequired).toBe(false);
    expect(tenant.selfEnrolmentEnabled).toBe(true);
  });

  it('allows the same pair once the administrator holds a factor', async () => {
    const admin = await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, admin.id));

    const res = await put(cookie, {
      adminMfaRequired: true,
      selfEnrolmentEnabled: false,
    });
    expect(res.statusCode).toBe(200);
  });

  it('will not write the SLUG, but the primary domain is now writable', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();

    // The slug stays out of the schema, and for a sharper reason than before:
    // it is the fallback `resolveTenantId` uses when the domain does not
    // match, so it is the way back in when the domain is set wrong. A tenant
    // able to change both could strand itself with no route to its own
    // console.
    //
    // The domain used to be frozen alongside it, which meant an operator
    // deploying at their own hostname had no way to say so short of SQL.
    // REFUSED OUTRIGHT now, where it used to be silently stripped. The schema
    // is `.strict()`, so a key it does not declare is a 400 rather than a 200
    // that quietly did less than the caller asked -- which is the same
    // invariant, enforced where the caller can see it.
    const refused = await put(cookie, {
      slug: 'somebody-else',
      primaryDomain: 'syntra.example.com',
      name: 'Acme Care',
    });
    expect(refused.statusCode).toBe(400);

    const untouched = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    expect(untouched.slug).toBe('acme');
    // And nothing else moved either: a refused body writes none of its fields.
    expect(untouched.name).toBe('Acme');

    const res = await put(cookie, {
      primaryDomain: 'syntra.example.com',
      name: 'Acme Care',
    });
    expect(res.statusCode).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    expect(tenant.slug).toBe('acme');
    expect(tenant.primaryDomain).toBe('syntra.example.com');
    expect(tenant.name).toBe('Acme Care');
  });

  it('refuses a hostname carrying a scheme, port or path', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();
    for (const bad of ['http://x.test', 'x.test:5173', 'x.test/path', 'has space']) {
      const res = await put(cookie, { primaryDomain: bad });
      expect(res.statusCode, bad).toBe(400);
    }
    // A bare hostname and an IP are both fine: `resolveTenantId` compares the
    // Host header as a plain string, so an instance reached by address has a
    // perfectly good primary domain.
    expect((await put(cookie, { primaryDomain: '192.168.1.10' })).statusCode).toBe(200);
  });

  it('refuses to move the domain until the passkey count is acknowledged', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();
    await put(cookie, { primaryDomain: 'first.example.com' });

    // Through `withTenant`, not the bare client. Every table here is FORCE ROW
    // LEVEL SECURITY against `current_setting('app.current_tenant')`, so
    // `prisma.user.findFirst()` outside a bound transaction matches nothing
    // whatever the database holds — and the create that followed it would fail
    // for a reason with nothing to do with the code under test.
    await withTenant(ctx.tenantId, async (tx) => {
      const user = await tx.user.findFirstOrThrow({});
      await tx.webAuthnCredential.create({
        data: {
          tenantId: ctx.tenantId,
          userId: user.id,
          credentialId: `probe-${ctx.tenantId}`,
          publicKey: Buffer.from([0]),
          counter: 0,
          rpId: 'first.example.com',
          label: 'probe key',
        },
      });
    });

    // WebAuthn binds each credential to the relying party it was created
    // against. Moving the domain does not migrate them — it makes every one
    // unusable, silently, at whatever moment its holder next signs in.
    const refused = await put(cookie, { primaryDomain: 'second.example.com' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().passkeys).toBe(1);

    // A wrong number is not an acknowledgement: it is what a client would send
    // if it had cached a stale count, and it must not pass for consent.
    expect(
      (await put(cookie, { primaryDomain: 'second.example.com', ackPasskeys: 7 })).statusCode,
    ).toBe(409);

    expect(
      (await put(cookie, { primaryDomain: 'second.example.com', ackPasskeys: 1 })).statusCode,
    ).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    // `Tenant` is the one table that is NOT tenant-scoped — it is the table
    // tenants are rows of — so the bare client is correct here and only here.
    expect(tenant.primaryDomain).toBe('second.example.com');
  });

  it('rejects a password minimum below the product floor', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    expect((await put(await adminCookie(), { passwordMinLength: 4 })).statusCode).toBe(400);
  });

  it('refuses a write without tenant.manage', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    expect((await put(await adminCookie(), { adminMfaRequired: true })).statusCode).toBe(403);
  });
});

describe('changing the tenant domain', () => {
  /**
   * `providerFor` fixes the issuer at construction -- oidc-provider asserts a
   * single web URI and never re-reads it -- and caches one Provider per
   * tenant. `invalidateProvider` is called on client changes and on key
   * rotation, and was NOT called here, which is the one route that changes
   * `primaryDomain`. Every token kept the old `iss` until a restart or an
   * unrelated rotation, and a relying party validates `iss` against the issuer
   * it discovered, so the tokens simply stopped being accepted.
   */
  it('drops the cached OIDC provider so the issuer is rebuilt', async () => {
    const spy = vi.spyOn(protocols, 'invalidateProvider');
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();

    const res = await put(cookie, { primaryDomain: 'id.acme.example' });
    expect(res.statusCode, res.body).toBe(200);
    expect(spy).toHaveBeenCalledWith(ctx.tenantId);
    spy.mockRestore();
  });

  /**
   * And NOT on a change that cannot move the issuer. Rebuilding the provider
   * discards every cached client and re-reads the key set, which is real work
   * on a route an administrator might save from twice in a row.
   */
  it('leaves the cache alone when no hostname changed', async () => {
    const spy = vi.spyOn(protocols, 'invalidateProvider');
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();

    const res = await put(cookie, { adminMfaRequired: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('PUT /api/admin/tenant and the password policy', () => {
  let cookie: string;
  beforeEach(async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    cookie = await adminCookie();
  });

  /**
   * Reads back what was SAVED, not what was sent. `updateTenant` writes a
   * hand-maintained list of fields, so a setting can be accepted by the
   * contract, echoed by the response and never persisted — which is exactly
   * what happened to the lockout fields when they were first added.
   */
  it('persists the lockout policy', async () => {
    const res = await put(cookie, {
      lockoutThreshold: 5,
      lockoutWindowMinutes: 30,
      lockoutDurationMinutes: 0,
    });
    expect(res.statusCode).toBe(200);

    const saved = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    expect(saved).toMatchObject({
      lockoutThreshold: 5,
      lockoutWindowMinutes: 30,
      lockoutDurationMinutes: 0,
    });
  });

  it('persists the password ageing policy', async () => {
    const res = await put(cookie, { passwordMaxAgeDays: 90, passwordHistoryDepth: 5 });
    expect(res.statusCode).toBe(200);

    const saved = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    expect(saved).toMatchObject({
      passwordMaxAgeDays: 90,
      passwordHistoryDepth: 5,
    });
  });

  it('refuses an expiry short enough to be a denial of service', async () => {
    // Zero is off and 30 is the floor; one day would ask every user in the
    // tenant to choose a new password daily.
    expect((await put(cookie, { passwordMaxAgeDays: 1 })).statusCode).toBe(400);
    expect((await put(cookie, { passwordMaxAgeDays: 0 })).statusCode).toBe(200);
  });

  it('refuses a lockout threshold of one', async () => {
    expect((await put(cookie, { lockoutThreshold: 1 })).statusCode).toBe(400);
  });
});

/**
 * The branding routes.
 *
 * Every refusal here is about the SIGN-IN page: a colour nobody can read, or a
 * logo that fetches from somewhere, renders before anybody has authenticated.
 */
describe('the tenant brand', () => {
  const putBrand = (cookie: string, payload: unknown) =>
    ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/tenant/brand',
      headers: { host: ctx.host, cookie },
      payload: payload as object,
    });

  const getBrand = (cookie: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/api/admin/tenant/brand',
      headers: { host: ctx.host, cookie },
    });

  it('needs tenant.manage, like every other tenant setting', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    expect((await getBrand(await adminCookie())).statusCode).toBe(403);
  });

  it('saves a name and a readable colour', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();
    const res = await putBrand(cookie, { name: 'Acme', primary: '#2563eb' });
    expect(res.statusCode).toBe(200);
    expect(await getBrand(cookie).then((r) => r.json())).toMatchObject({
      name: 'Acme',
      primary: '#2563eb',
    });
  });

  it('refuses a colour that cannot be read, and says by how much', async () => {
    // "That colour is not allowed" sends an administrator back to guessing.
    // The measured ratio and the direction to move in is the difference.
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const res = await putBrand(await adminCookie(), { primary: '#fffbe6' });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/:1/);
    expect(res.json().detail).toMatch(/light page/);
  });

  it('refuses a logo that would be fetched from somewhere else', async () => {
    // A logo that fetches is a logo that tells its host who is signing in and
    // when — and it stops rendering the day that host moves.
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const res = await putBrand(await adminCookie(), {
      logo: 'https://cdn.example.test/logo.png',
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an SVG logo', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const res = await putBrand(await adminCookie(), {
      logo: 'data:image/svg+xml;base64,QUFB',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/SVG/);
  });

  it('refuses a misspelled field rather than saving nothing and reporting success', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const res = await putBrand(await adminCookie(), { brandPrimay: '#2563eb' });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the logo out of the audit payload', async () => {
    // An audit event is read far more often than a logo changes, and a
    // quarter-megabyte data URI in every export is a cost nobody signed up
    // for. Whether one is set is the fact an auditor wants.
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    await putBrand(await adminCookie(), { logo: 'data:image/png;base64,QUFB' });

    // Through `withTenant`, like every other audit assertion in the suite.
    // The raw client sets no `app.current_tenant`, and `FORCE ROW LEVEL
    // SECURITY` hides the row from it entirely — which reads as "no event was
    // written" and is not.
    const event = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { action: 'tenant.brand_updated' },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(event).not.toBeNull();
    expect(JSON.stringify(event!.payload)).not.toContain('QUFB');
    expect(JSON.stringify(event!.payload)).toContain('set');
  });

  it('clears back to Syntra on a null', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();
    await putBrand(cookie, { name: 'Acme' });
    await putBrand(cookie, { name: null });
    expect(await getBrand(cookie).then((r) => r.json())).toMatchObject({ name: null });
  });
});
