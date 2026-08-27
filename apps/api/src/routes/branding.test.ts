import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@syntra/db';
import { buildTestApp, TEST_HOST } from '../test-support.js';

/**
 * The brand, read without a session.
 *
 * Unauthenticated on purpose: the sign-in page is the first thing anybody
 * sees, and a brand that only appeared after signing in would appear exactly
 * where it stops mattering.
 */

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const get = (host = TEST_HOST) =>
  ctx.app.inject({ method: 'GET', url: '/api/branding', headers: { host } });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('GET /api/branding', () => {
  it('answers an unbranded tenant with nulls rather than a 404', async () => {
    // A 404 would leave the sign-in page choosing between an error state and a
    // silent fallback for what is simply the default.
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: null, logo: null, primary: null, accent: null });
  });

  it('needs no session', async () => {
    // No cookie is sent above at all. Stated as its own case because the
    // whole endpoint exists for the one screen nobody has authenticated on.
    const res = await get();
    expect(res.statusCode).toBe(200);
  });

  it('returns what the tenant set', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { brandName: 'Acme', brandPrimary: '#2563eb' },
    });
    expect(await get().then((r) => r.json())).toMatchObject({
      name: 'Acme',
      primary: '#2563eb',
    });
  });

  it('is cached privately, never publicly', async () => {
    // A shared proxy caching this publicly would serve one tenant's brand on
    // another tenant's hostname.
    const res = await get();
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['cache-control']).not.toContain('public');
  });

  it('is still scoped to a tenant, so an unknown host gets nothing', async () => {
    const res = await get('nobody.example.test');
    expect(res.statusCode).toBe(404);
  });
});
