import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  generateRecoveryCodes,
  setPassword,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'a-long-enough-password';

async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPassword(tx, user.id, PASSWORD);
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

  it('will not write the slug or the primary domain', async () => {
    await seedAdmin([...ALL_PERMISSIONS]);
    const cookie = await adminCookie();

    // A body naming them is not an error; the fields simply are not in the
    // schema, so there is nothing for them to reach.
    const res = await put(cookie, {
      slug: 'somebody-else',
      primaryDomain: 'evil.test',
      name: 'Acme Care',
    });
    expect(res.statusCode).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
    });
    expect(tenant.slug).toBe('acme');
    expect(tenant.primaryDomain).toBeNull();
    expect(tenant.name).toBe('Acme Care');
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
