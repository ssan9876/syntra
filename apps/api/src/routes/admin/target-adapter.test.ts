import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

const adConfig = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

/** A signed-in, elevated administrative session holding exactly `permissions`. */
async function adminCookie(permissions: Permission[]): Promise<string> {
  const login = `admin-${permissions.join('-')}`;
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login, email: `${permissions.join('.')}@acme.test`, displayName: 'Admin' });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `R-${permissions.join('-')}`, permissions);
    await assignRole(tx, user.id, role.id);
  });
  const signIn = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login', headers: { host: ctx.host }, payload: { login, password: PASSWORD },
  });
  const token = signIn.cookies.find((c) => c.name === 'syntra_session')!.value;
  const elevated = await ctx.app.inject({
    method: 'POST', url: '/api/auth/elevate', headers: { host: ctx.host, cookie: `syntra_session=${token}` }, payload: { password: PASSWORD },
  });
  return `syntra_session=${elevated.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const send = (method: 'GET' | 'PUT' | 'POST', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { host: ctx.host, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

const manager = () => adminCookie([PERMISSIONS.PROVISION_MANAGE, PERMISSIONS.PROVISION_READ]);

async function createTarget(cookie: string, body: Record<string, unknown>) {
  const response = await send('POST', '/api/admin/targets', cookie, { bindPassword: 'secret-credential', ...body });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('GET /api/admin/targets/:id/adapter', () => {
  it('reports the effective release, its certified capabilities and no warning for a supported adapter', async () => {
    const cookie = await manager();
    const id = await createTarget(cookie, { name: 'Acme AD', type: 'activeDirectory', config: adConfig });
    const response = await send('GET', `/api/admin/targets/${id}/adapter`, cookie);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      type: 'activeDirectory',
      selection: { channel: 'stable', pinnedVersion: null, rollbackVersion: null },
      effective: { source: 'stable', release: { adapterVersion: '1.0.0' } },
      warnings: [],
      writesBlockedReason: null,
      deprecationOverride: null,
    });
    expect(body.capabilities).toHaveLength(9);
    expect(body.capabilities.every((c: { certified: boolean; refusal: string | null }) => c.certified && c.refusal === null)).toBe(true);
  });

  it('shows what a SCIM target refuses and warns about a partially certified adapter', async () => {
    const cookie = await manager();
    const scim = await createTarget(cookie, { name: 'SCIM', type: 'scim2', config: { baseUrl: 'https://scim.acme.test/v2' } });
    const scimReport = (await send('GET', `/api/admin/targets/${scim}/adapter`, cookie)).json();
    const grant = scimReport.capabilities.find((c: { capability: string }) => c.capability === 'grant_entitlement');
    expect(grant).toMatchObject({ certified: true });
    expect(grant.refusal).toMatch(/does not advertise the ability to grant entitlements/);
    const container = scimReport.capabilities.find((c: { capability: string }) => c.capability === 'create_container');
    expect(container).toMatchObject({ certified: false });

    const entra = await createTarget(cookie, {
      name: 'Entra', type: 'entraId', config: { tenantId: 'contoso.onmicrosoft.com', clientId: 'client-1' },
    });
    const readiness = await send('GET', `/api/admin/targets/${entra}/readiness`, cookie);
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().adapterWarnings[0]).toMatch(/only partially certified/);
  });
});

describe('adapter rollout controls', () => {
  it('requires PROVISION_MANAGE to change the adapter', async () => {
    const cookie = await manager();
    const id = await createTarget(cookie, { name: 'Acme AD', type: 'activeDirectory', config: adConfig });
    const reader = await adminCookie([PERMISSIONS.PROVISION_READ]);
    const response = await send('PUT', `/api/admin/targets/${id}/adapter`, reader, {
      channel: 'canary', reason: 'Try the next release',
    });
    expect(response.statusCode).toBe(403);
    expect((await send('GET', `/api/admin/targets/${id}/adapter`, reader)).statusCode).toBe(200);
  });

  it('moves a target to the canary channel with an audited reason, and refuses what cannot run', async () => {
    const cookie = await manager();
    const id = await createTarget(cookie, { name: 'Acme AD', type: 'activeDirectory', config: adConfig });

    expect((await send('PUT', `/api/admin/targets/${id}/adapter`, cookie, { channel: 'canary', reason: 'short' })).statusCode).toBe(400);

    const moved = await send('PUT', `/api/admin/targets/${id}/adapter`, cookie, {
      channel: 'canary', reason: 'Pilot the next adapter here first',
    });
    expect(moved.statusCode).toBe(200);
    // No canary release is published for this type, so the canary lane runs
    // the stable default rather than leaving the target without an adapter.
    expect(moved.json()).toMatchObject({
      selection: { channel: 'canary', reason: 'Pilot the next adapter here first' },
      effective: { source: 'stable', release: { adapterVersion: '1.0.0' } },
    });

    const unknown = await send('PUT', `/api/admin/targets/${id}/adapter`, cookie, {
      channel: 'stable', version: '9.9.9', reason: 'Pin to a release that does not exist',
    });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().type).toContain('adapter-selection-refused');

    const rollback = await send('POST', `/api/admin/targets/${id}/adapter/rollback`, cookie, { reason: 'Nothing to roll back to yet' });
    expect(rollback.statusCode).toBe(409);
    expect(rollback.json().detail).toMatch(/no previous certified adapter release/);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.adapter.select', targetId: id } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ channel: 'canary', toVersion: '1.0.0' });
  });

  it('bounds deprecation overrides and refuses one for a supported release', async () => {
    const cookie = await manager();
    const id = await createTarget(cookie, { name: 'Acme AD', type: 'activeDirectory', config: adConfig });
    const tooLong = await send('POST', `/api/admin/targets/${id}/adapter/deprecation-override`, cookie, {
      reason: 'Migration is not finished yet', expiresAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
    });
    expect(tooLong.statusCode).toBe(400);
    const notDeprecated = await send('POST', `/api/admin/targets/${id}/adapter/deprecation-override`, cookie, {
      reason: 'Migration is not finished yet', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(notDeprecated.statusCode).toBe(409);
    expect(notDeprecated.json().detail).toMatch(/is not deprecated/);
  });
});
