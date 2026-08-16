import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;
let otherTenantId: string;
let applicationId: string;

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const b = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  tenantId = a.id;
  otherTenantId = b.id;
  applicationId = await withTenant(tenantId, async (tx) => {
    const app = await tx.application.create({
      data: { tenantId, name: 'CRM', slug: 'crm', type: 'saml' },
    });
    return app.id;
  });
});

const key = (over: Record<string, unknown>) => ({
  tenantId,
  kind: 'oidc',
  alg: 'RS256',
  publicJwk: {},
  status: 'active',
  notBefore: new Date(),
  notAfter: new Date(Date.now() + 60_000),
  ...over,
});

describe('access 2 schema', () => {
  it('gives an OIDC client PKCE on, client credentials off, and no redirect URIs', async () => {
    const client = await withTenant(tenantId, (tx) =>
      tx.oidcClient.create({
        data: { tenantId, applicationId, clientId: 'crm', clientSecretHash: 'x' },
      }),
    );
    expect(client.requirePkce).toBe(true);
    // The grant that bypasses authorize() is never on by default (A2-5).
    expect(client.clientCredentialsEnabled).toBe(false);
    // Empty rather than a permissive default: an unconfigured client can
    // complete no flow at all, which is the safe starting state.
    expect(client.redirectUris).toEqual([]);
  });

  it('allows one active signing key per tenant and kind, with an outgoing one beside it', async () => {
    await withTenant(tenantId, (tx) =>
      tx.signingKey.create({ data: key({ kid: 'k1', secretName: 's1' }) }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.signingKey.create({ data: key({ kid: 'k2', secretName: 's2' }) }),
      ),
    ).rejects.toThrow();
    // The half a plain UNIQUE(tenantId, kind) would fail: a rollover needs
    // both keys present at once.
    const outgoing = await withTenant(tenantId, (tx) =>
      tx.signingKey.create({
        data: key({ kid: 'k3', secretName: 's3', status: 'outgoing' }),
      }),
    );
    expect(outgoing.status).toBe('outgoing');
  });

  it('lets two tenants each hold an active oidc key', async () => {
    for (const t of [tenantId, otherTenantId]) {
      await withTenant(t, (tx) =>
        tx.signingKey.create({
          data: { ...key({ kid: `k-${t}`, secretName: `s-${t}` }), tenantId: t },
        }),
      );
    }
    // A bare `prisma.*` read outside `withTenant` sees nothing under this
    // schema's RLS — `with-tenant.test.ts` asserts exactly that ("reads
    // nothing when no tenant is bound") — so each tenant's row is confirmed
    // through its own scoped read rather than a cross-tenant count.
    const rowsA = await withTenant(tenantId, (tx) =>
      tx.signingKey.findMany({ where: { status: 'active' } }),
    );
    const rowsB = await withTenant(otherTenantId, (tx) =>
      tx.signingKey.findMany({ where: { status: 'active' } }),
    );
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
  });

  it('constrains an oidc artifact uid only when the uid is present', async () => {
    const base = {
      tenantId,
      model: 'Session',
      payload: {},
      expiresAt: new Date(Date.now() + 60_000),
    };
    // Two rows with a null uid coexist, which is the ordinary case for every
    // model that has no uid at all.
    await withTenant(tenantId, (tx) =>
      tx.oidcArtifact.createMany({
        data: [
          { ...base, artifactId: 'a' },
          { ...base, artifactId: 'b' },
        ],
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.oidcArtifact.create({ data: { ...base, artifactId: 'c', uid: 'u1' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.oidcArtifact.create({ data: { ...base, artifactId: 'd', uid: 'u1' } }),
      ),
    ).rejects.toThrow();
  });

  it('refuses to read another tenant rows even when the query names them', async () => {
    await withTenant(tenantId, (tx) =>
      tx.upstreamIdp.create({
        data: { tenantId, slug: 'entra', name: 'Entra ID', protocol: 'oidc' },
      }),
    );
    const seen = await withTenant(otherTenantId, (tx) =>
      // Deliberately written wrongly: naming the other tenant's id explicitly.
      tx.upstreamIdp.findMany({ where: { tenantId } }),
    );
    expect(seen).toEqual([]);
  });

  it('refuses to write a row into another tenant', async () => {
    await expect(
      withTenant(otherTenantId, (tx) =>
        tx.upstreamIdp.create({
          data: { tenantId, slug: 'smuggled', name: 'Smuggled', protocol: 'oidc' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a federate rule with no upstream, and a non-federate rule with one', async () => {
    const policyId = await withTenant(tenantId, async (tx) => {
      const p = await tx.authPolicy.create({ data: { tenantId } });
      return p.id;
    });
    const upstreamId = await withTenant(tenantId, async (tx) => {
      const u = await tx.upstreamIdp.create({
        data: { tenantId, slug: 'entra', name: 'Entra ID', protocol: 'oidc' },
      });
      return u.id;
    });
    await expect(
      withTenant(tenantId, (tx) =>
        tx.authPolicyRule.create({
          data: { tenantId, policyId, position: 1, name: 'r', outcome: 'federate' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantId, (tx) =>
        tx.authPolicyRule.create({
          data: {
            tenantId, policyId, position: 2, name: 'r2',
            outcome: 'allow', upstreamIdpId: upstreamId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
