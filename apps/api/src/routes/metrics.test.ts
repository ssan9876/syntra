import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureActiveKey,
  localMasterKeyProvider,
  recordEvent,
  resetSecurityEventCounts,
} from '@syntra/core';
import { withTenant } from '@syntra/db';
import { buildTestApp, TEST_HOST } from '../test-support.js';

const TOKEN = 'a-long-enough-metrics-token';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

/** An app with metrics turned on. */
const withMetrics = async () => {
  ctx = await buildTestApp({ env: { METRICS_TOKEN: TOKEN } });
  await ctx.app.ready();
  return ctx;
};

/** An app with no token, which is the default and means no route. */
const withoutMetrics = async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  return ctx;
};

const scrape = (token: string | null = TOKEN) =>
  ctx.app.inject({
    method: 'GET',
    url: '/metrics',
    headers: {
      host: TEST_HOST,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });

describe('when no token is configured', () => {
  beforeEach(withoutMetrics);

  it('does not have the route at all', async () => {
    // 404 rather than 403, deliberately. A route that answered 403 would
    // confirm its own existence, and the existence of a metrics endpoint tells
    // somebody probing what this deployment is and how it is operated.
    expect((await scrape()).statusCode).toBe(404);
  });

  it('does not have it for an unauthenticated caller either', async () => {
    expect((await scrape(null)).statusCode).toBe(404);
  });
});

describe('when a token is configured', () => {
  beforeEach(withMetrics);

  it('refuses a caller with no credential', async () => {
    expect((await scrape(null)).statusCode).toBe(401);
  });

  it('refuses a wrong token', async () => {
    expect((await scrape('not-the-metrics-token')).statusCode).toBe(401);
  });

  it('refuses a token of a different length without throwing', async () => {
    // `timingSafeEqual` throws on a length mismatch, which would be a 500 and
    // a timing signal at once.
    expect((await scrape('short')).statusCode).toBe(401);
  });

  it('serves Prometheus text exposition to the right token', async () => {
    const res = await scrape();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toMatch(/^# HELP /m);
    expect(res.body).toMatch(/^# TYPE /m);
  });

  it('reports the running version', async () => {
    expect((await scrape()).body).toContain('syntra_build_info');
  });

  it('reports process and runtime metrics', async () => {
    // The metrics somebody actually wants when the API is slow.
    const body = (await scrape()).body;
    expect(body).toContain('syntra_process_cpu_seconds_total');
    expect(body).toMatch(/syntra_nodejs_eventloop_lag/);
  });
});

describe('request timings', () => {
  beforeEach(withMetrics);

  it('labels by route pattern, never by URL', async () => {
    // THE property of this feature. `request.url` would put user ids and
    // tenant hostnames into label values -- unbounded cardinality and a
    // disclosure in one move.
    const id = '11111111-2222-4333-8444-555555555555';
    await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${id}/sessions`,
      headers: { host: TEST_HOST },
    });

    const body = (await scrape()).body;
    expect(body).toContain('syntra_http_request_duration_seconds');
    expect(body).not.toContain(id);
    expect(body).toContain('/api/admin/users/:id/sessions');
  });

  it('puts no tenant hostname in any label', async () => {
    await ctx.app.inject({
      method: 'GET',
      url: '/api/portal/applications',
      headers: { host: TEST_HOST },
    });

    expect((await scrape()).body).not.toContain(TEST_HOST);
  });

  it('does not mint a series per scanned path', async () => {
    // A 404 has no route pattern. Falling back to `request.url` there would
    // let anybody grow the series set by probing.
    await ctx.app.inject({
      method: 'GET',
      url: '/wp-admin/setup-config.php',
      headers: { host: TEST_HOST },
    });

    const body = (await scrape()).body;
    expect(body).not.toContain('wp-admin');
    expect(body).toContain('unrouted');
  });

  it('records the status it answered with', async () => {
    await ctx.app.inject({
      method: 'GET',
      url: '/api/portal/applications',
      headers: { host: TEST_HOST },
    });

    expect((await scrape()).body).toMatch(/status="401"/);
  });
});

describe('the installation gauges', () => {
  beforeEach(withMetrics);

  it('publishes the queue backlogs and the account counts', async () => {
    const body = (await scrape()).body;

    expect(body).toContain('syntra_webhook_deliveries_pending');
    expect(body).toContain('syntra_logout_deliveries_abandoned');
    expect(body).toContain('syntra_sessions_active');
    expect(body).toContain('syntra_accounts_locked');
    expect(body).toMatch(/syntra_users_total\{status="active"\}/);
  });

  it('publishes no key expiry at all when there is no key', async () => {
    // NOT zero. `gauge.reset()` sets a gauge to 0, and 0 here reads as
    // "expires now" -- it would page somebody at three in the morning for a
    // deployment that has issued no tokens. The metric is taken out of the
    // registry instead, and an absent series is what Prometheus understands as
    // "no data".
    const body = (await scrape()).body;

    expect(body).not.toContain('syntra_signing_key_expires_in_seconds');
  });

  it('publishes the key expiry once a key exists', async () => {
    // The metric earns its place: key rotation is scheduled monthly and its
    // failure is silent until every token stops verifying at once.
    await ensureActiveKey(ctx.tenantId, localMasterKeyProvider(Buffer.alloc(32, 7)), 'oidc');

    // Before the first scrape, so the ten-second cache is populated with the
    // key already in place.
    const body = (await scrape()).body;

    const match = /syntra_signing_key_expires_in_seconds ([0-9.e+]+)/.exec(body);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
  });

  it('carries no tenant id or slug anywhere in the body', async () => {
    // Asserted over the WHOLE rendered body rather than per metric, because
    // that is the property that matters and it is easy to reintroduce with one
    // careless label.
    const body = (await scrape()).body;

    expect(body).not.toContain(ctx.tenantId);
    expect(body).not.toContain('acme');
  });
});

describe('security event counts', () => {
  beforeEach(async () => {
    await withMetrics();
    // Process-local, and a suite shares the process.
    resetSecurityEventCounts();
  });

  it('counts a security event by action and outcome', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'auth.lockout',
        targetType: 'User',
        targetId: null,
        outcome: 'failure',
        sourceIp: null,
        payload: {},
      }),
    );

    const body = (await scrape()).body;

    expect(body).toContain('syntra_audit_events_total');
    expect(body).toMatch(/action="auth\.lockout"/);
    expect(body).toMatch(/outcome="failure"/);
  });

  it('does not count ordinary traffic, so the label set stays bounded', async () => {
    // Counting every audited action would grow the series set with the audit
    // vocabulary, and the vocabulary grows with the product.
    await withTenant(ctx.tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'application.launch',
        targetType: 'Application',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: {},
      }),
    );

    expect((await scrape()).body).not.toContain('application.launch');
  });

  it('does not double-count across two scrapes', async () => {
    // The counter is copied from a map, and a copy that re-added the whole
    // total each time would climb without anything happening.
    await withTenant(ctx.tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'auth.lockout',
        targetType: 'User',
        targetId: null,
        outcome: 'failure',
        sourceIp: null,
        payload: {},
      }),
    );

    await scrape();
    const body = (await scrape()).body;

    const match = /syntra_audit_events_total\{[^}]*\} ([0-9.e+]+)/.exec(body);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(1);
  });
});
