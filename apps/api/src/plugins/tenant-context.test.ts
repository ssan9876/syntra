import { describe, expect, it } from 'vitest';
import { prisma } from '@syntra/db';
import { buildTestApp } from '../test-support.js';

describe('tenant resolution', () => {
  it('binds the tenant matching the request host', async () => {
    const { app, tenantId, host } = await buildTestApp();
    app.get('/whoami', async (req) => ({ tenantId: req.tenantId }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { host },
    });
    expect(res.json()).toEqual({ tenantId });
  });

  it('resolves by primary domain in preference to slug', async () => {
    const { app } = await buildTestApp();
    const branded = await prisma.tenant.create({
      data: {
        name: 'Branded',
        slug: 'branded',
        primaryDomain: 'id.branded.test',
      },
    });
    app.get('/whoami', async (req) => ({ tenantId: req.tenantId }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { host: 'id.branded.test' },
    });
    expect(res.json()).toEqual({ tenantId: branded.id });
  });

  it('ignores the port when matching a host', async () => {
    const { app, tenantId, host } = await buildTestApp();
    app.get('/whoami', async (req) => ({ tenantId: req.tenantId }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { host: `${host}:3000` },
    });
    expect(res.json()).toEqual({ tenantId });
  });

  it('returns 404 for an unknown host rather than falling back to a default', async () => {
    const { app } = await buildTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/anything',
      headers: { host: 'nope.syntra.test' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe('https://syntra.dev/problems/unknown-tenant');
  });

  it('refuses a suspended tenant', async () => {
    const { app } = await buildTestApp();
    await prisma.tenant.create({
      data: { name: 'Gone', slug: 'gone', status: 'suspended' },
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/anything',
      headers: { host: 'gone.syntra.test' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('scopes request.db to the resolved tenant', async () => {
    const { app, host } = await buildTestApp();
    app.get('/count', async (req) => {
      const users = await req.db((tx) => tx.user.findMany());
      return { count: users.length };
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/count',
      headers: { host },
    });
    expect(res.json()).toEqual({ count: 0 });
  });

  it('does not leak rows from another tenant through request.db', async () => {
    const { app, host } = await buildTestApp();
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    // Seeded in the other tenant; the acme-scoped request must not see it.
    const { withTenant } = await import('@syntra/db');
    const { createUser } = await import('@syntra/core');
    await withTenant(other.id, (tx) =>
      createUser(tx, {
        login: 'stranger',
        email: 's@other.test',
        displayName: 'S',
      }),
    );

    app.get('/count', async (req) => {
      const users = await req.db((tx) => tx.user.findMany());
      return { count: users.length };
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/count',
      headers: { host },
    });
    expect(res.json()).toEqual({ count: 0 });
  });
});
