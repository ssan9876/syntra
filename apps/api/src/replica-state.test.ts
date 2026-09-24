import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma, withTenant } from '@syntra/db';
import {
  createApplication,
  ensureActiveKey,
  localMasterKeyProvider,
  memoryTransport,
  retireExpiredKeys,
  rotateKey,
  upsertOidcClient,
} from '@syntra/core';
import { createProviderCache, type ProviderCache } from '@syntra/protocols';
import { buildApp } from './app.js';
import { oidcProviderDeps } from './routes/oidc-op.js';
import { tenantProtocolIdentity } from './routes/protocol-identity.js';
import { buildTestApp, TEST_HOST } from './test-support.js';
import { postgresRateLimitCounter } from './plugins/rate-limit-store.js';

/**
 * The two pieces of per-process state that made more than one API replica
 * incorrect, each proved with two "replicas" sharing one database.
 */

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const MASTER_KEY = Buffer.alloc(32, 7);
const OPTIONS = { keyProvider: localMasterKeyProvider(MASTER_KEY), sessionSecret: 'x'.repeat(32) };

const generation = async (tenantId: string) =>
  (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).oidcConfigGeneration;

const client = (clientId: string, redirect: string) => ({
  clientId,
  redirectUris: [redirect],
  postLogoutRedirectUris: [],
  grantTypes: ['authorization_code'],
  scopes: ['openid'],
  requirePkce: true,
  clientCredentialsEnabled: false,
  tokenEndpointAuthMethod: 'client_secret_basic',
  idTokenSignedResponseAlg: 'RS256',
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 0,
});

/**
 * What one replica does per OIDC request, minus the HTTP: read the tenant row
 * (which `oidcProviderFor` already does, for the issuer), and ask ITS OWN
 * cache for a Provider at the generation on that row. `kids` records the
 * signing keys each build of this replica's Provider was handed.
 */
function replica(tenantId: string) {
  const cache: ProviderCache = createProviderCache();
  const kids: string[][] = [];
  const deps = oidcProviderDeps(tenantId, OPTIONS);
  const recordingDeps = {
    ...deps,
    jwks: async () => {
      const jwks = await deps.jwks();
      kids.push(jwks.keys.map((k) => k.kid as string));
      return jwks;
    },
  };
  return {
    kids,
    serve: async () => {
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const { issuer } = tenantProtocolIdentity(tenant, `http://${TEST_HOST}`);
      return cache.providerFor(tenantId, issuer, recordingDeps, tenant.oidcConfigGeneration);
    },
  };
}

beforeEach(async () => {
  ctx = await buildTestApp();
});

describe('the OIDC provider cache across replicas', () => {
  let applicationId: string;

  beforeEach(async () => {
    applicationId = await withTenant(ctx.tenantId, async (tx) => {
      const app = await createApplication(tx, { name: 'CRM', slug: 'crm', type: 'oidc' });
      await upsertOidcClient(tx, app.id, client('crm', 'https://crm.acme.test/cb'));
      return app.id;
    });
    // The tenant's first OIDC key, made up front. Otherwise the first build
    // makes it (`jwks()` calls `ensureActiveKey`), which is itself a key
    // change: it bumps the generation past the one that build was read at,
    // and the next request rebuilds once -- correct, and a one-off per tenant,
    // but noise in a test about what does and does not cause a rebuild.
    await ensureActiveKey(ctx.tenantId, localMasterKeyProvider(MASTER_KEY), 'oidc');
  });

  it("sees a client change made through another replica on its next request", async () => {
    const a = replica(ctx.tenantId);
    const b = replica(ctx.tenantId);
    const warmB = await b.serve();
    await a.serve();
    expect(await b.serve()).toBe(warmB); // cached while nothing changed

    // Replica A's admin route: the client's redirect URI moves.
    const before = await generation(ctx.tenantId);
    await withTenant(ctx.tenantId, (tx) =>
      upsertOidcClient(tx, applicationId, client('crm', 'https://crm.acme.test/new-cb')),
    );
    expect(await generation(ctx.tenantId)).toBeGreaterThan(before);

    // Replica B was never told. It must still serve the new registration.
    const rebuilt = await b.serve();
    expect(rebuilt).not.toBe(warmB);
    const crm = await rebuilt.Client.find('crm');
    expect(crm?.redirectUris).toEqual(['https://crm.acme.test/new-cb']);
    // And it caches again at the new generation rather than rebuilding each time.
    expect(await b.serve()).toBe(rebuilt);
  });

  it('sees a client created by a path that never called invalidateProvider', async () => {
    const b = replica(ctx.tenantId);
    const warm = await b.serve();
    expect(await warm.Client.find('hr')).toBeUndefined();

    // Straight to the table, as the catalog install does.
    await withTenant(ctx.tenantId, async (tx) => {
      const hr = await createApplication(tx, { name: 'HR', slug: 'hr', type: 'oidc' });
      await upsertOidcClient(tx, hr.id, client('hr', 'https://hr.acme.test/cb'));
    });

    expect(await (await b.serve()).Client.find('hr')).toBeDefined();
  });

  /**
   * The case that made this an outage rather than a nuisance: a replica that
   * did not hear about a rotation keeps signing with the old key, and once the
   * old key is retired and unpublished every token it issues fails
   * validation.
   */
  it('signs with the rotated key on every replica, and drops a retired one', async () => {
    const a = replica(ctx.tenantId);
    const b = replica(ctx.tenantId);
    await a.serve();
    await b.serve();
    const [original] = b.kids.at(-1)!;

    // The rotation runs in some other process (the worker's job).
    const { incoming } = await rotateKey(ctx.tenantId, localMasterKeyProvider(MASTER_KEY), 'oidc');
    await b.serve();
    expect(b.kids.at(-1)![0]).toBe(incoming.kid);
    expect(b.kids.at(-1)).toContain(original);

    await retireExpiredKeys(ctx.tenantId, 'oidc', new Date(Date.now() + 30 * 86_400_000));
    await b.serve();
    expect(b.kids.at(-1)).toEqual([incoming.kid]);
  });

  it('does not rebuild for a SAML key rotation, which no Provider holds', async () => {
    const b = replica(ctx.tenantId);
    const warm = await b.serve();
    const before = await generation(ctx.tenantId);

    await rotateKey(ctx.tenantId, localMasterKeyProvider(MASTER_KEY), 'saml');

    expect(await generation(ctx.tenantId)).toBe(before);
    expect(await b.serve()).toBe(warm);
  });

  it('rebuilds with the new issuer when the tenant hostname moves', async () => {
    const b = replica(ctx.tenantId);
    const warm = await b.serve();
    const before = await generation(ctx.tenantId);

    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: 'id.acme.example' },
    });
    expect(await generation(ctx.tenantId)).toBeGreaterThan(before);

    const rebuilt = await b.serve();
    expect(rebuilt).not.toBe(warm);
    expect(rebuilt.issuer).toBe('http://id.acme.example/oidc');
  });

  it('does not bump the generation for a tenant setting unrelated to OIDC', async () => {
    const before = await generation(ctx.tenantId);
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });
    expect(await generation(ctx.tenantId)).toBe(before);
  });

  it('rebuilds when a client is deleted', async () => {
    const b = replica(ctx.tenantId);
    const warm = await b.serve();
    await withTenant(ctx.tenantId, (tx) => tx.oidcClient.delete({ where: { applicationId } }));

    const rebuilt = await b.serve();
    expect(rebuilt).not.toBe(warm);
    expect(await rebuilt.Client.find('crm')).toBeUndefined();
  });
});

describe('rate limits across replicas', () => {
  let replicas: FastifyInstance[];

  const secondReplica = async () => {
    // The same configuration the first replica was built with, over the same
    // database, without resetting it.
    const b = await buildApp(ctx.config, {
      logger: false,
      transport: memoryTransport(),
    });
    await b.ready();
    return b;
  };

  const attempt = (app: FastifyInstance, address = '198.51.100.7') =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: TEST_HOST },
      remoteAddress: address,
      payload: { login: 'nobody', password: 'wrong' },
    });

  it('spends one per-address allowance between two replicas, not one each', async () => {
    ctx = await buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '4', AUTH_RATE_LIMIT_TENANT_MAX: '100' } });
    await ctx.app.ready();
    replicas = [ctx.app, await secondReplica()];

    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await attempt(replicas[i % 2]!)).statusCode);

    // Four in total across both, then refused on either.
    expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codes.slice(4)).toEqual([429, 429, 429, 429]);
    await replicas[1]!.close();
  });

  it('holds the per-tenant ceiling across addresses AND replicas', async () => {
    ctx = await buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_TENANT_MAX: '5' } });
    await ctx.app.ready();
    replicas = [ctx.app, await secondReplica()];

    const codes: number[] = [];
    for (let i = 1; i <= 8; i++) {
      codes.push((await attempt(replicas[i % 2]!, `203.0.113.${i}`)).statusCode);
    }

    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    await replicas[1]!.close();
  });

  /**
   * The defect itself, kept visible: the per-process store grants each replica
   * the whole allowance. This is why `postgres` is the default.
   */
  it('grants each replica the whole allowance with the in-memory store', async () => {
    ctx = await buildTestApp({
      env: { AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_TENANT_MAX: '100', RATE_LIMIT_STORE: 'memory' },
    });
    await ctx.app.ready();
    replicas = [ctx.app, await secondReplica()];

    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await attempt(replicas[i % 2]!)).statusCode);
    expect(codes).toEqual([401, 401, 401, 401]);
    await replicas[1]!.close();
  });

  it('keeps separate routes on separate counters, as the in-memory store did', async () => {
    ctx = await buildTestApp({ env: { AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_TENANT_MAX: '100' } });
    await ctx.app.ready();
    for (let i = 0; i < 3; i++) await attempt(ctx.app);
    expect((await attempt(ctx.app)).statusCode).toBe(429);

    // A different limited route from the same address still has its own two.
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: { host: TEST_HOST },
      remoteAddress: '198.51.100.7',
      payload: { login: 'nobody' },
    });
    expect(reset.statusCode).not.toBe(429);
  });
});

describe('the Postgres rate-limit counter', () => {
  it('counts within a window, reports the time left, and starts a new window after it', async () => {
    const first = await postgresRateLimitCounter.hit('t|k', 300, null);
    const second = await postgresRateLimitCounter.hit('t|k', 300, null);
    expect(first.hits).toBe(1);
    expect(second.hits).toBe(2);
    expect(second.ttlMs).toBeGreaterThan(0);
    expect(second.ttlMs).toBeLessThanOrEqual(300);

    await new Promise((resolve) => setTimeout(resolve, 350));
    const fresh = await postgresRateLimitCounter.hit('t|k', 300, null);
    expect(fresh.hits).toBe(1);
  });

  it('restarts the window on every hit past max only when asked to', async () => {
    await postgresRateLimitCounter.hit('t|c', 400, { max: 1 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const past = await postgresRateLimitCounter.hit('t|c', 400, { max: 1 });
    expect(past.hits).toBe(2);
    // Restarted: nearly the whole window again, not the ~200ms left.
    expect(past.ttlMs).toBeGreaterThan(300);
  });

  it('sweeps ended windows and leaves live ones', async () => {
    await postgresRateLimitCounter.hit('t|old', 1, null);
    await postgresRateLimitCounter.hit('t|live', 60_000, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await postgresRateLimitCounter.sweep()).toBeGreaterThanOrEqual(1);
    const keys = (
      await prisma.$queryRaw<{ key: string }[]>`SELECT "key" FROM "RateLimitBucket"`
    ).map((row) => row.key);
    expect(keys).toContain('t|live');
    expect(keys).not.toContain('t|old');
  });
});
