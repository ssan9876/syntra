import { afterEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { assignRole, createRole, createSession, createUser, PERMISSIONS, verificationRecord, type TxtLookup } from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
afterEach(async () => { await ctx?.app.close(); });

async function adminCookie(permissions: string[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login: 'owner', email: 'owner@acme.test', displayName: 'Owner' });
    const role = await createRole(tx, 'Domains', permissions as never);
    await assignRole(tx, user.id, role.id);
    const session = await createSession(tx, {
      status: 'allow', userId: user.id, mayElevate: true,
      scope: 'admin', applicationId: null, satisfiedFactor: null,
    }, { ip: null, userAgent: null });
    return `syntra_session=${session.token}`;
  });
}

describe('email domains', () => {
  it('adds a domain unverified, verifies it from DNS, and records both', async () => {
    const published = new Map<string, string[]>();
    const lookup: TxtLookup = async (name) => published.get(name) ?? [];
    ctx = await buildTestApp({ txtLookup: lookup, verifiedDomains: [] });
    const cookie = await adminCookie([PERMISSIONS.TENANT_MANAGE]);
    const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: { host: ctx.host, cookie }, ...(payload === undefined ? {} : { payload }) });

    const added = await call('POST', '/api/admin/email-domains', { domain: 'Contoso.COM' });
    expect(added.statusCode).toBe(201);
    const domain = added.json();
    expect(domain).toMatchObject({ domain: 'contoso.com', verifiedAt: null });
    expect(domain.record).toMatch(/^syntra-domain-verification=/);

    expect((await call('POST', '/api/admin/email-domains', { domain: 'contoso.com' })).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/email-domains', { domain: '10.0.0.1' })).statusCode).toBe(400);

    const notYet = await call('POST', `/api/admin/email-domains/${domain.id}/verify`);
    expect(notYet.statusCode).toBe(200);
    expect(notYet.json()).toMatchObject({ verifiedAt: null, lastCheckError: 'contoso.com does not publish the verification record yet' });

    published.set('contoso.com', ['v=spf1 -all', domain.record]);
    const verified = await call('POST', `/api/admin/email-domains/${domain.id}/verify`);
    expect(verified.json().verifiedAt).not.toBeNull();
    expect(verified.json().lastCheckError).toBeNull();

    const actions = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { targetId: domain.id }, orderBy: { sequence: 'asc' }, select: { action: true } }),
    );
    expect(actions.map((a) => a.action)).toEqual([
      'tenant.email_domain.added',
      'tenant.email_domain.verification_failed',
      'tenant.email_domain.verified',
    ]);

    expect((await call('DELETE', `/api/admin/email-domains/${domain.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/api/admin/email-domains')).json()).toEqual([]);
  });

  it('needs tenant.manage', async () => {
    ctx = await buildTestApp();
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/admin/email-domains', payload: { domain: 'contoso.com' },
      headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a business email outside every verified domain, and accepts one inside', async () => {
    ctx = await buildTestApp({ txtLookup: async () => [], verifiedDomains: [] });
    const cookie = await adminCookie([PERMISSIONS.TENANT_MANAGE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
    const create = (businessEmail: string, givenName = 'Jane') => ctx.app.inject({
      method: 'POST', url: '/api/admin/persons', headers: { host: ctx.host, cookie },
      payload: { givenName, familyName: 'Doe', businessEmail },
    });

    const refused = await create('Jane_Doe@deeznutz.org');
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      type: 'https://syntra.dev/problems/email-domain-not-verified',
      domain: 'deeznutz.org',
      errors: [{ path: 'businessEmail', message: 'deeznutz.org is not a verified email domain for this organisation' }],
    });

    await withTenant(ctx.tenantId, (tx) =>
      tx.emailDomain.create({
        data: { tenantId: ctx.tenantId, domain: 'acme.test', verificationToken: 't', verifiedAt: new Date() },
      }),
    );
    expect((await create('jane.doe@acme.test')).statusCode).toBe(201);
    expect((await create('ola.doe@eu.acme.test', 'Ola')).statusCode).toBe(201);
    expect(verificationRecord('t')).toBe('syntra-domain-verification=t');
  });
});
