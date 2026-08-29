import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  WEBHOOK_EVENT_GROUP_KEYS,
  WEBHOOK_MAX_ATTEMPTS,
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

describe('GET /api/admin/webhooks — health', () => {
  it('reports pending and failing counts per endpoint, and the latest failure', async () => {
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();
    // `approvals`, not `[]`. An empty list means EVERY event, and since the
    // security groups landed that includes `configuration` -- so an
    // all-events endpoint also hears about webhook endpoints being created,
    // including its own. That behaviour has its own test below; this one is
    // about health counts being grouped per endpoint and should not depend on
    // how many other kinds of event happen to exist.
    const mine = (
      await call('POST', '/api/admin/webhooks', cookie, {
        ...anEndpoint,
        events: ['approvals'],
      })
    ).json().endpoint;
    const other = (
      await call('POST', '/api/admin/webhooks', cookie, {
        ...anEndpoint,
        name: 'Other',
        // Not subscribed to `automate-stage-opened` (that is the `approvals`
        // group; this endpoint asks only for `fulfilment`), so this endpoint
        // stays untouched — the control that proves the health query is
        // grouped per endpoint rather than summed across all of them.
        events: ['fulfilment'],
      })
    ).json().endpoint;

    // One `enqueueOutbox` call per event: drafts in the same call collapse
    // into a single webhook delivery (one event addressed to several
    // people), so three distinct deliveries need three separate calls.
    for (const to of ['a@example.com', 'b@example.com', 'c@example.com']) {
      await withTenant(ctx.tenantId, (tx) =>
        enqueueOutbox(tx, [
          { template: 'automate-stage-opened', to, vars: {}, requestId: null, userId: null },
        ]),
      );
    }

    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.webhookDelivery.findMany({ where: { endpointId: mine.id }, orderBy: { createdAt: 'asc' } }),
    );
    // One still pending, one that has exhausted its retries with a recorded
    // error, one delivered (and so excluded from both counts).
    const older = new Date('2026-08-20T00:00:00Z');
    const newer = new Date('2026-08-21T00:00:00Z');
    await withTenant(ctx.tenantId, (tx) =>
      Promise.all([
        tx.webhookDelivery.update({
          where: { id: rows[0]!.id },
          data: { attempts: WEBHOOK_MAX_ATTEMPTS, lastError: 'connection refused', createdAt: older },
        }),
        tx.webhookDelivery.update({
          where: { id: rows[1]!.id },
          data: { attempts: WEBHOOK_MAX_ATTEMPTS, lastError: 'timed out', createdAt: newer },
        }),
        tx.webhookDelivery.update({
          where: { id: rows[2]!.id },
          data: { deliveredAt: new Date() },
        }),
      ]),
    );

    const listed = await call('GET', '/api/admin/webhooks', cookie);
    const endpoints = listed.json().endpoints as {
      id: string;
      pending: number;
      failing: number;
      lastFailureAt: string | null;
    }[];
    const mineHealth = endpoints.find((e) => e.id === mine.id)!;
    const otherHealth = endpoints.find((e) => e.id === other.id)!;

    expect(mineHealth.pending).toBe(0);
    expect(mineHealth.failing).toBe(2);
    expect(mineHealth.lastFailureAt).toBe(newer.toISOString());
    expect(otherHealth.pending).toBe(0);
    expect(otherHealth.failing).toBe(0);
    expect(otherHealth.lastFailureAt).toBeNull();
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
      await call('POST', '/api/admin/webhooks', cookie, {
        ...anEndpoint,
        // `approvals` rather than every event: this asserts the shape of ONE
        // delivery, and an all-events endpoint now also hears about its own
        // creation.
        events: ['approvals'],
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

describe('an endpoint hears about configuration changes, including its own', () => {
  it('delivers webhook configuration changes to a configuration subscriber', async () => {
    // Deliberate, and the reason it is deliberate: somebody quietly
    // repointing an integration is exactly the change that integration should
    // announce. An endpoint subscribed to `configuration` -- or to everything,
    // which is what an empty list means -- therefore hears about webhook
    // endpoints being created, edited, deleted and re-secreted.
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();

    const watcher = (
      await call('POST', '/api/admin/webhooks', cookie, {
        ...anEndpoint,
        name: 'Watcher',
        events: ['configuration'],
      })
    ).json().endpoint;

    await call('POST', '/api/admin/webhooks', cookie, {
      ...anEndpoint,
      name: 'Somebody else',
      url: 'https://other.example.test/in',
      events: ['fulfilment'],
    });

    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.webhookDelivery.findMany({ where: { endpointId: watcher.id } }),
    );
    const events = rows.map((r) => r.event);
    expect(events).toContain('notify.webhook_created');
  });

  it('carries no endpoint URL or secret in the body', async () => {
    // The projection is seven fields and none of them is the payload, so the
    // URL an administrator typed does not travel to a third party -- not even
    // to a third party that is allowed to know an endpoint changed.
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await adminCookie();

    const watcher = (
      await call('POST', '/api/admin/webhooks', cookie, {
        ...anEndpoint,
        name: 'Watcher',
        events: ['configuration'],
      })
    ).json().endpoint;

    await call('POST', '/api/admin/webhooks', cookie, {
      ...anEndpoint,
      name: 'Somebody else',
      url: 'https://secret-internal.example.test/in',
      events: ['fulfilment'],
    });

    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.webhookDelivery.findMany({ where: { endpointId: watcher.id } }),
    );
    const body = JSON.stringify(rows.map((r) => r.payload));
    expect(body).not.toContain('secret-internal.example.test');
  });
});
