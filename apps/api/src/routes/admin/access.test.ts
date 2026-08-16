import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createGroup,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let adminCookie: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';

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


beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  userId = await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Ada',
    });
    await setPasswordHash(tx, u.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Owner', ALL_PERMISSIONS);
    await assignRole(tx, u.id, role.id);
    return u.id;
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const portal = login.cookies.find((c) => c.name === 'syntra_session')!.value;

  const elevated = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  adminCookie = elevated.cookies.find((c) => c.name === 'syntra_session')!.value;
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  cookie = adminCookie,
) => {
  const headers = { host: ctx.host, cookie: `syntra_session=${cookie}` };
  // Two calls rather than a spread: `exactOptionalPropertyTypes` will not let
  // a possibly-absent `payload` be handed to inject as `object | undefined`.
  return payload === undefined
    ? ctx.app.inject({ method, url, headers })
    : ctx.app.inject({ method, url, headers, payload });
};

const newApp = (slug = 'crm') =>
  call('POST', '/api/admin/applications', {
    name: 'CRM',
    slug,
    launchUrl: 'https://crm.acme.test/',
  });

describe('applications', () => {
  it('creates one and lists it', async () => {
    const created = await newApp();
    expect(created.statusCode).toBe(201);

    const list = await call('GET', '/api/admin/applications');
    expect(list.json().applications).toHaveLength(1);
    expect(list.json().applications[0]).toMatchObject({ slug: 'crm', type: 'bookmark' });
  });

  it('rejects a duplicate slug with 409', async () => {
    await newApp();
    expect((await newApp()).statusCode).toBe(409);
  });

  it('rejects a slug with capitals or spaces', async () => {
    const res = await call('POST', '/api/admin/applications', {
      name: 'CRM',
      slug: 'My CRM',
      launchUrl: 'https://crm.acme.test/',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a launch URL that is not a URL', async () => {
    const res = await call('POST', '/api/admin/applications', {
      name: 'CRM',
      slug: 'crm',
      launchUrl: 'javascript:alert(1)',
    });
    expect(res.statusCode).toBe(400);
  });

  it('holds an icon URL to the same schemes as a launch URL', async () => {
    // The field is plumbed to the web `Tile` type. Nothing renders it today,
    // which makes it the field that is one task away from being a sink rather
    // than the field that is safe.
    const res = await call('POST', '/api/admin/applications', {
      name: 'CRM',
      slug: 'crm',
      launchUrl: 'https://crm.acme.test/',
      iconUrl: 'javascript:alert(1)',
    });
    expect(res.statusCode).toBe(400);

    const ok = await call('POST', '/api/admin/applications', {
      name: 'CRM',
      slug: 'crm',
      launchUrl: 'https://crm.acme.test/',
      iconUrl: 'https://crm.acme.test/icon.png',
    });
    expect(ok.statusCode).toBe(201);
  });

  it('names a duplicate slug as a conflict rather than as any error at all', async () => {
    // The route used to turn every error out of createApplication into 409
    // "That slug is already used", with the driver's message echoed into
    // `detail`. A conflict is named; anything else is a fault and says so.
    await newApp();
    const conflict = await newApp();
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().type).toBe('https://syntra.dev/problems/slug-taken');
  });

  it('refuses a portal session', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'admin', password: PASSWORD },
    });
    const portal = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    expect((await newApp('other')).statusCode).toBe(201);
    const res = await call('GET', '/api/admin/applications', undefined, portal);
    expect(res.statusCode).toBe(403);
  });

  it('writes an audit event on creation', async () => {
    await newApp();
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'application.create' } }),
    );
    expect(events).toHaveLength(1);
  });
});

describe('assignments', () => {
  it('assigns to a user, a group and an org unit and lists them', async () => {
    const appId = (await newApp()).json().id;
    const groupId = await withTenant(ctx.tenantId, async (tx) =>
      (await createGroup(tx, 'Nurses')).id,
    );

    expect(
      (await call('POST', `/api/admin/applications/${appId}/assignments`, {
        type: 'user',
        id: userId,
      })).statusCode,
    ).toBe(201);
    expect(
      (await call('POST', `/api/admin/applications/${appId}/assignments`, {
        type: 'group',
        id: groupId,
      })).statusCode,
    ).toBe(201);

    const list = await call('GET', `/api/admin/applications/${appId}/assignments`);
    expect(list.json().assignments).toHaveLength(2);
  });

  it('is idempotent', async () => {
    const appId = (await newApp()).json().id;
    const body = { type: 'user', id: userId };
    await call('POST', `/api/admin/applications/${appId}/assignments`, body);
    await call('POST', `/api/admin/applications/${appId}/assignments`, body);
    const list = await call('GET', `/api/admin/applications/${appId}/assignments`);
    expect(list.json().assignments).toHaveLength(1);
  });

  it('removes one', async () => {
    const appId = (await newApp()).json().id;
    await call('POST', `/api/admin/applications/${appId}/assignments`, {
      type: 'user',
      id: userId,
    });
    const id = (await call('GET', `/api/admin/applications/${appId}/assignments`)).json()
      .assignments[0].id;
    expect(
      (await call('DELETE', `/api/admin/applications/${appId}/assignments/${id}`)).statusCode,
    ).toBe(204);
  });
});

describe('the policy', () => {
  it('starts empty with an allow default', async () => {
    const res = await call('GET', '/api/admin/policy');
    expect(res.json()).toEqual({
      fallback: { outcome: 'allow', factorType: null },
      rules: [],
      // Federate rows come back separately from the rules the authorization
      // engine evaluates, so a routing rule can never be read as an outcome.
      routes: [],
    });
  });

  it('adds rules in order', async () => {
    await call('POST', '/api/admin/policy/rules', { name: 'First', outcome: 'allow' });
    await call('POST', '/api/admin/policy/rules', { name: 'Second', outcome: 'deny' });
    const res = await call('GET', '/api/admin/policy');
    expect(res.json().rules.map((r: { name: string }) => r.name)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('rejects require_factor with no factor named', async () => {
    const res = await call('POST', '/api/admin/policy/rules', {
      name: 'Bad',
      outcome: 'require_factor',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a half-specified time window', async () => {
    const res = await call('POST', '/api/admin/policy/rules', {
      name: 'Bad',
      outcome: 'deny',
      startMinute: 540,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unusable timezone with a message naming the field', async () => {
    const res = await call('POST', '/api/admin/policy/rules', {
      name: 'Bad',
      outcome: 'deny',
      startMinute: 0,
      endMinute: 60,
      timezone: 'Middle/Earth',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('timezone');
  });

  it('rejects a malformed CIDR', async () => {
    const res = await call('POST', '/api/admin/policy/rules', {
      name: 'Bad',
      outcome: 'deny',
      ipRanges: ['10.0.0.0/33'],
    });
    expect(res.statusCode).toBe(400);
  });

  it('reorders', async () => {
    const a = (await call('POST', '/api/admin/policy/rules', { name: 'A', outcome: 'allow' })).json();
    const b = (await call('POST', '/api/admin/policy/rules', { name: 'B', outcome: 'allow' })).json();
    await call('PUT', '/api/admin/policy/rules/order', { ruleIds: [b.id, a.id] });
    const res = await call('GET', '/api/admin/policy');
    expect(res.json().rules.map((r: { name: string }) => r.name)).toEqual(['B', 'A']);
  });

  it('deletes and closes the gap', async () => {
    await call('POST', '/api/admin/policy/rules', { name: 'A', outcome: 'allow' });
    const b = (await call('POST', '/api/admin/policy/rules', { name: 'B', outcome: 'allow' })).json();
    await call('POST', '/api/admin/policy/rules', { name: 'C', outcome: 'allow' });
    await call('DELETE', `/api/admin/policy/rules/${b.id}`);
    const res = await call('GET', '/api/admin/policy');
    expect(res.json().rules.map((r: { position: number }) => r.position)).toEqual([1, 2]);
  });

  it('sets the tenant default', async () => {
    // require_factor: webauthn is refused for a tenant with no primaryDomain
    // — the relying party is derived from it — so it must be set first.
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });

    await call('PUT', '/api/admin/policy/default', {
      outcome: 'require_factor',
      factorType: 'webauthn',
    });
    const res = await call('GET', '/api/admin/policy');
    expect(res.json().fallback).toEqual({ outcome: 'require_factor', factorType: 'webauthn' });
  });

  it('reports how many users a rule would affect before it is saved', async () => {
    // The same shape of mistake Directory Sync's deactivation threshold exists
    // for: a change that touches everyone must not be indistinguishable from
    // one that touches nobody until after it has happened.
    const res = await call('POST', '/api/admin/policy/rules/impact', {
      name: 'Everyone needs a factor',
      outcome: 'require_mfa',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      totalActiveUsers: 1,
      matchedUsers: 1,
      usersNeedingEnrolment: 1,
      unevaluatedConditions: [],
    });
  });

  it('names the conditions the preview could not test', async () => {
    const res = await call('POST', '/api/admin/policy/rules/impact', {
      name: 'Offsite',
      outcome: 'deny',
      ipRanges: ['203.0.113.0/24'],
    });
    expect(res.json().unevaluatedConditions).toEqual(['source address']);
  });

  it('rate-limits the preview and requires the stronger permission', async () => {
    // Storing nothing is not the same as costing nothing: this endpoint can
    // count every user and every membership in the tenant, and it answers "how
    // many of your people have no second factor".
    const res = await call('POST', '/api/admin/policy/rules/impact', {
      name: 'Everyone',
      outcome: 'require_mfa',
    });
    expect(res.statusCode).toBe(200);

    const reader = await withTenant(ctx.tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'reader',
        email: 'reader@acme.test',
        displayName: 'Reader',
      });
      await setPasswordHash(tx, u.id, PASSWORD_HASH);
      const role = await createRole(tx, 'Policy reader', [PERMISSIONS.POLICY_READ]);
      await assignRole(tx, u.id, role.id);
      return u;
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'reader', password: PASSWORD },
    });
    const portal = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    const elevated = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
      payload: { password: PASSWORD },
    });
    const readerCookie = elevated.cookies.find((c) => c.name === 'syntra_session')!.value;

    expect(reader.id).toBeTruthy();
    const refused = await call(
      'POST',
      '/api/admin/policy/rules/impact',
      { name: 'Everyone', outcome: 'require_mfa' },
      readerCookie,
    );
    expect(refused.statusCode).toBe(403);
  });

  it('previews without storing anything', async () => {
    await call('POST', '/api/admin/policy/rules/impact', {
      name: 'Everyone',
      outcome: 'require_mfa',
    });
    expect((await call('GET', '/api/admin/policy')).json().rules).toEqual([]);
  });

  it('writes an audit event for every policy change', async () => {
    await call('POST', '/api/admin/policy/rules', { name: 'A', outcome: 'deny' });
    await call('PUT', '/api/admin/policy/default', { outcome: 'deny' });
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { targetType: 'AuthPolicy' } }),
    );
    expect(events.map((e) => e.action).sort()).toEqual([
      'policy.default_set',
      'policy.rule_added',
    ]);
  });
});
