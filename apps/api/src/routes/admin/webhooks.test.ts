import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  WEBHOOK_EVENT_GROUP_KEYS,
  assignRole,
  createRole,
  createUser,
  enqueueOutbox,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { webhookEventGroups } from '@syntra/contracts';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'a-long-enough-password';
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

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const anEndpoint = {
  name: 'Ticketing',
  url: 'https://hooks.example.com/syntra',
  enabled: true,
  events: ['approvals'],
};

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('the event groups', () => {
  it('are the same list in contracts and in core', () => {
    // Contracts depends on nothing, so the list is written twice on purpose.
    // This is what stops the two drifting: a group added to one and not the
    // other would be a value the console offers and the sender ignores.
    expect([...webhookEventGroups].sort()).toEqual([...WEBHOOK_EVENT_GROUP_KEYS].sort());
  });
});

describe('POST /api/admin/webhooks', () => {
  it('needs an administrative session', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/webhooks',
      headers: { host: ctx.host },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a caller without tenant.manage', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const res = await call('GET', '/api/admin/webhooks', await adminCookie());
    expect(res.statusCode).toBe(403);
  });

  it('creates an endpoint and returns the secret once', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();

    const created = await call('POST', '/api/admin/webhooks', cookie, anEndpoint);
    expect(created.statusCode).toBe(201);
    expect(created.json().secret).toMatch(/^whsec_/);

    const listed = await call('GET', '/api/admin/webhooks', cookie);
    expect(listed.json().endpoints).toHaveLength(1);
    // The secret is not in the listing, in any field, at any depth.
    expect(listed.payload).not.toContain(created.json().secret);
  });

  it('refuses an address this deployment will not send to', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const res = await call('POST', '/api/admin/webhooks', await adminCookie(), {
      ...anEndpoint,
      url: 'ftp://files.example.com/drop',
    });
    // A 400 the form can put under the URL field, not a 500.
    expect(res.statusCode).toBe(400);
  });

  it('refuses a credential embedded in the address', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const res = await call('POST', '/api/admin/webhooks', await adminCookie(), {
      ...anEndpoint,
      url: 'https://user:pass@hooks.example.com/syntra',
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a field it does not know', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const res = await call('POST', '/api/admin/webhooks', await adminCookie(), {
      ...anEndpoint,
      secret: 'let me choose it',
    });
    expect(res.statusCode).toBe(400);
  });

  it('records the destination in the audit trail', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    await call('POST', '/api/admin/webhooks', await adminCookie(), anEndpoint);

    const event = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'notify.webhook_created' } }),
    );
    expect(event).not.toBeNull();
    expect(event!.payload).toMatchObject({ url: anEndpoint.url });
  });
});

describe('POST /api/admin/webhooks/:id/secret', () => {
  it('issues a different secret and shows it once', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();
    const created = await call('POST', '/api/admin/webhooks', cookie, anEndpoint);
    const { id } = created.json().endpoint;

    const rotated = await call('POST', `/api/admin/webhooks/${id}/secret`, cookie);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().secret).not.toBe(created.json().secret);
  });
});

describe('PUT /api/admin/webhooks/:id', () => {
  it('leaves fields the body did not mention alone', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();
    const { id } = (await call('POST', '/api/admin/webhooks', cookie, anEndpoint)).json()
      .endpoint;

    await call('PUT', `/api/admin/webhooks/${id}`, cookie, { enabled: false });

    // Read back from the database, not from the response. A route that echoes
    // what it was sent without writing it is the defect this asserts against.
    const row = await withTenant(ctx.tenantId, (tx) =>
      tx.webhookEndpoint.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.enabled).toBe(false);
    expect(row.name).toBe('Ticketing');
    expect(row.events).toEqual(['approvals']);
  });
});

describe('GET /api/admin/webhooks/:id/deliveries', () => {
  it('shows what was queued, and what state it is in', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();
    const { id } = (
      await call('POST', '/api/admin/webhooks', cookie, { ...anEndpoint, events: [] })
    ).json().endpoint;

    await withTenant(ctx.tenantId, (tx) =>
      enqueueOutbox(tx, [
        {
          template: 'automate-stage-opened',
          to: 'approver@example.com',
          vars: {},
          requestId: null,
          userId: null,
        },
      ]),
    );

    const res = await call('GET', `/api/admin/webhooks/${id}/deliveries`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().deliveries).toMatchObject([
      { event: 'automate-stage-opened', state: 'queued', attempts: 0 },
    ]);
  });

  it('refuses to retry a delivery belonging to another endpoint', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();
    const first = (
      await call('POST', '/api/admin/webhooks', cookie, { ...anEndpoint, events: [] })
    ).json().endpoint;
    const second = (
      await call('POST', '/api/admin/webhooks', cookie, {
        ...anEndpoint,
        name: 'Other',
        events: [],
      })
    ).json().endpoint;

    await withTenant(ctx.tenantId, (tx) =>
      enqueueOutbox(tx, [
        {
          template: 'automate-stage-opened',
          to: 'approver@example.com',
          vars: {},
          requestId: null,
          userId: null,
        },
      ]),
    );
    const mine = (await call('GET', `/api/admin/webhooks/${first.id}/deliveries`, cookie))
      .json()
      .deliveries[0];

    const res = await call(
      'POST',
      `/api/admin/webhooks/${second.id}/deliveries/${mine.id}/retry`,
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/admin/webhooks/:id', () => {
  it('takes the queued deliveries with it', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();
    const { id } = (
      await call('POST', '/api/admin/webhooks', cookie, { ...anEndpoint, events: [] })
    ).json().endpoint;

    await withTenant(ctx.tenantId, (tx) =>
      enqueueOutbox(tx, [
        {
          template: 'automate-stage-opened',
          to: 'approver@example.com',
          vars: {},
          requestId: null,
          userId: null,
        },
      ]),
    );

    expect((await call('DELETE', `/api/admin/webhooks/${id}`, cookie)).statusCode).toBe(204);
    expect(await withTenant(ctx.tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });
});
