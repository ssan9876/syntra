import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { parseXml, selectElements } from '@syntra/protocols';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('GET /saml/metadata', () => {
  it('serves metadata whose entity ID is built from the tenant, not the Host header', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/saml/metadata',
      headers: { host: TEST_HOST },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/samlmetadata+xml');
    const doc = parseXml(res.body);
    expect(doc.documentElement!.getAttribute('entityID')).toBe(
      `http://${TEST_HOST}/saml/idp`,
    );
    expect(selectElements(doc, "//*[local-name(.)='X509Certificate']").length)
      .toBeGreaterThan(0);
  });

  it('refuses a request that arrived on a sibling of the tenant host', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/saml/metadata',
      // Resolves tenant "acme" through the leftmost label, and would
      // otherwise publish an entity ID under the attacker's domain.
      headers: { host: `${TEST_HOST}.attacker.example` },
    });
    expect(res.statusCode).toBe(421);
  });

  it('is stable across calls, so an SP that pins the entity ID keeps working', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });
    const one = await ctx.app.inject({ method: 'GET', url: '/saml/metadata', headers: { host: TEST_HOST } });
    const two = await ctx.app.inject({ method: 'GET', url: '/saml/metadata', headers: { host: TEST_HOST } });
    expect(one.body).toBe(two.body);
    // And exactly one key was created, not one per request. SigningKey is
    // tenant-scoped and RLS-forced, so this has to go through withTenant —
    // a bare `prisma.signingKey.findMany()` matches no rows at all, since
    // no session has `app.current_tenant` set outside a bound transaction,
    // which would make this assertion pass for the wrong reason (or, as
    // written against a real bug, fail every time regardless of how many
    // keys actually exist).
    const keys = await withTenant(ctx.tenantId, (tx) =>
      tx.signingKey.findMany({ where: { kind: 'saml' } }),
    );
    expect(keys).toHaveLength(1);
  });
});
