import { describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { PERMISSIONS } from '@syntra/core';
import { buildTestApp } from '../test-support.js';
import { SETUP_TOKEN_TTL_MS, createFirstRunSetup } from '../first-run-setup.js';
import { signInUrl } from './setup.js';

const PASSWORD = 'correct-horse-battery';

const form = (token: string, over: Record<string, unknown> = {}) => ({
  token,
  organizationName: 'Northwind',
  slug: 'northwind',
  primaryDomain: 'acme.syntra.test',
  adminEmail: 'Anna@Northwind.example',
  adminDisplayName: 'Anna Novak',
  password: PASSWORD,
  ...over,
});

/** A fresh install: no tenant, the link opened as `server.ts` opens it. */
async function freshInstall(now?: () => Date) {
  const firstRunSetup = createFirstRunSetup(now ? { now } : {});
  const ctx = await buildTestApp({ withoutTenant: true, firstRunSetup });
  const link = await ctx.app.firstRunSetup.open();
  if (!link) throw new Error('setup should open on an empty database');
  // Any hostname: there is no tenant for one to resolve to.
  const host = 'idm.unconfigured.test';
  const check = (token?: string) =>
    ctx.app.inject({
      method: 'GET',
      url: token === undefined ? '/api/setup' : `/api/setup?token=${encodeURIComponent(token)}`,
      headers: { host },
    });
  const submit = (payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/api/setup', headers: { host }, payload });
  return { ...ctx, link, check, submit };
}

describe('first-run setup', () => {
  it('describes the form to the holder of the link, suggesting PUBLIC_URL as the domain', async () => {
    const { check, link } = await freshInstall();
    const res = await check(link.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      primaryDomain: 'acme.syntra.test',
      passwordMinLength: 12,
      expiresAt: link.expiresAt.toISOString(),
    });
  });

  it('requires the token on every call', async () => {
    const { check, submit, link } = await freshInstall();
    expect((await check()).statusCode).toBe(403);
    const { token: _omitted, ...withoutToken } = form(link.token);
    const res = await submit(withoutToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ title: 'Setup link not valid' });
    expect(await prisma.tenant.count()).toBe(0);
  });

  it('refuses a wrong token, before looking at the rest of the body', async () => {
    const { check, submit } = await freshInstall();
    const wrong = 'A'.repeat(43);
    expect((await check(wrong)).statusCode).toBe(403);
    // An invalid body with a wrong token is still a 403: no field errors for
    // somebody without the link.
    const res = await submit({ token: wrong, slug: 'NOT A SLUG' });
    expect(res.statusCode).toBe(403);
    expect(res.json().errors).toBeUndefined();
    expect(await prisma.tenant.count()).toBe(0);
  });

  it('refuses an expired link with 410', async () => {
    let now = new Date('2026-10-03T12:00:00.000Z');
    const { check, submit, link } = await freshInstall(() => now);
    now = new Date(now.getTime() + SETUP_TOKEN_TTL_MS + 1);
    const res = await check(link.token);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ title: 'Setup link expired', detail: 'Restart the API to print a new link.' });
    expect((await submit(form(link.token))).statusCode).toBe(410);
    expect(await prisma.tenant.count()).toBe(0);
  });

  it('validates the form, naming the field', async () => {
    const { submit, link } = await freshInstall();
    const bad = await submit(form(link.token, { slug: 'Not a slug', adminEmail: 'nobody' }));
    expect(bad.statusCode).toBe(400);
    const paths = (bad.json().errors as { path: string }[]).map((e) => e.path).sort();
    expect(paths).toEqual(['adminEmail', 'slug']);

    const weak = await submit(form(link.token, { password: 'short' }));
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ type: expect.stringContaining('weak-password'), errors: [{ path: 'password' }] });
    // The same policy every later password is held to: not the login.
    const obvious = await submit(form(link.token, { password: 'anna@northwind.example' }));
    expect(obvious.statusCode).toBe(400);
    expect(await prisma.tenant.count()).toBe(0);

    // A refused form leaves the link usable.
    expect((await submit(form(link.token))).statusCode).toBe(201);
  });

  it('creates the tenant and its Owner the way the bootstrap script does, and audits it', async () => {
    const { submit, link, app } = await freshInstall();
    const res = await submit(form(link.token));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      login: 'anna@northwind.example',
      signInUrl: 'http://acme.syntra.test/login',
    });

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'northwind' } });
    expect(tenant).toMatchObject({ name: 'Northwind', primaryDomain: 'acme.syntra.test' });

    await withTenant(tenant.id, async (tx) => {
      const users = await tx.user.findMany();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        login: 'anna@northwind.example',
        email: 'anna@northwind.example',
        displayName: 'Anna Novak',
      });

      const owner = await tx.role.findFirstOrThrow({ where: { systemKey: 'owner' } });
      expect(owner.builtIn).toBe(true);
      expect(owner.permissions).toContain(PERMISSIONS.TENANT_MANAGE);
      expect(owner.permissions).not.toContain(PERMISSIONS.PERSON_PURGE);
      const assignments = await tx.roleAssignment.findMany();
      expect(assignments).toEqual([expect.objectContaining({ userId: users[0]!.id, roleId: owner.id })]);

      const events = await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } });
      expect(events.map((e) => e.action)).toEqual(['tenant.created']);
      expect(events[0]).toMatchObject({
        actorUserId: null,
        targetType: 'Tenant',
        targetId: tenant.id,
        outcome: 'success',
      });
      expect(events[0]!.payload).toMatchObject({
        via: 'setup',
        slug: 'northwind',
        ownerUserId: users[0]!.id,
        ownerRoleId: owner.id,
      });

      // The SAML signing key, as bootstrap establishes it.
      expect(await tx.signingKey.count()).toBeGreaterThan(0);
    });

    // And the Owner can sign in on the primary domain.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'acme.syntra.test' },
      payload: { login: 'anna@northwind.example', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
  });

  it('spends the link: the second use answers 404', async () => {
    const { submit, check, link } = await freshInstall();
    expect((await submit(form(link.token))).statusCode).toBe(201);
    const again = await submit(form(link.token, { slug: 'second', primaryDomain: 'second.test' }));
    expect(again.statusCode).toBe(404);
    expect((await check(link.token)).statusCode).toBe(404);
    expect(await prisma.tenant.count()).toBe(1);
  });

  it('lets one of two concurrent submissions through', async () => {
    const { submit, link } = await freshInstall();
    const [a, b] = await Promise.all([
      submit(form(link.token)),
      submit(form(link.token, { slug: 'second', primaryDomain: 'second.test' })),
    ]);
    // The loser is either still waiting (409) or arrived after (404).
    const [won, lost] = [a.statusCode, b.statusCode].sort();
    expect(won).toBe(201);
    expect([404, 409]).toContain(lost);
    expect(await prisma.tenant.count()).toBe(1);
  });

  it('answers 404 on an install that has a tenant, whatever the token', async () => {
    const ctx = await buildTestApp();
    // Nothing to open: a tenant exists.
    expect(await ctx.app.firstRunSetup.open()).toBeNull();
    for (const url of ['/api/setup', `/api/setup?token=${'A'.repeat(43)}`]) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ type: 'https://syntra.dev/problems/not-found', title: 'Not Found', status: 404 });
    }
    const post = await ctx.app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { host: ctx.host },
      payload: form('A'.repeat(43)),
    });
    expect(post.statusCode).toBe(404);
    expect(await prisma.tenant.count()).toBe(1);
  });

  it('closes a link opened before a tenant appeared another way', async () => {
    const { submit, link } = await freshInstall();
    // The bootstrap script, or another replica, got there first.
    await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    expect((await submit(form(link.token))).statusCode).toBe(404);
  });

  it('is rate-limited per address', async () => {
    const firstRunSetup = createFirstRunSetup();
    const ctx = await buildTestApp({ withoutTenant: true, firstRunSetup, env: { AUTH_RATE_LIMIT_MAX: '2' } });
    await ctx.app.firstRunSetup.open();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await ctx.app.inject({ method: 'GET', url: '/api/setup', headers: { host: ctx.host } })).statusCode);
    }
    expect(statuses).toEqual([403, 403, 429]);
  });
});

describe('signInUrl', () => {
  it('is PUBLIC_URL when the primary domain is its hostname, else the domain on its scheme', () => {
    expect(signInUrl('https://idm.contoso.com', 'idm.contoso.com')).toBe('https://idm.contoso.com/login');
    expect(signInUrl('http://localhost:8080', 'localhost')).toBe('http://localhost:8080/login');
    expect(signInUrl('https://idm.contoso.com', 'sso.contoso.com')).toBe('https://sso.contoso.com/login');
  });
});
