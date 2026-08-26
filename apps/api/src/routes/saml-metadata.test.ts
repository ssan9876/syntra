import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  createApplication,
  localMasterKeyProvider,
  saveSamlConfig,
} from '@syntra/core';
import { parseXml, selectElements } from '@syntra/protocols';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

// Deliberately not imported from `saml-sso-post.test.ts`. Importing a test
// file runs its whole suite again inside this one — that is why the SSO suites
// pay for each other's tests — and this file needs two literals, not a
// fixture. The master key is the one `buildTestApp` gives the app.
const samlKeyOptions = {
  provider: localMasterKeyProvider(Buffer.alloc(32, 7)),
  commonName: TEST_HOST,
};

const samlConfig = (over: Record<string, unknown> = {}) => ({
  spEntityId: 'https://sp.example.test/metadata',
  acsUrls: ['https://sp.example.test/acs'],
  defaultAcsUrl: 'https://sp.example.test/acs',
  acsBinding: 'HTTP-POST' as const,
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  nameIdClaim: null,
  spCertificates: [] as string[],
  wantAuthnRequestsSigned: false,
  encryptAssertions: false,
  encryptionCertificate: null,
  sloUrl: null,
  sloBinding: 'HTTP-POST' as const,
  allowIdpInitiated: false,
  assertionLifetimeMs: 300_000,
  ...over,
});

describe('GET /saml/metadata', () => {
  // Scoped to this describe rather than the module's top level. A top-level
  // `beforeEach` becomes a root-level hook for whatever file imports this one,
  // running before every test in *that* file and racing its database reset
  // against this one's — the shape Task 8 warned about, and the shape both SSO
  // suites already avoid. It was latent here only because nothing imports this
  // file, and "nothing imports it" is not a property a file keeps by accident.
  beforeEach(async () => {
    ctx = await buildTestApp();
    await ctx.app.ready();
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });
  });

  const fetchMetadata = () =>
    ctx.app.inject({ method: 'GET', url: '/saml/metadata', headers: { host: TEST_HOST } });

  it('serves metadata whose entity ID is built from the tenant, not the Host header', async () => {
    const res = await fetchMetadata();

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
    const one = await fetchMetadata();
    const two = await fetchMetadata();
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

  it('is rate limited, because it is unauthenticated and it mints keys', async () => {
    // `app.ts` registers @fastify/rate-limit with `global: false`, so a route
    // that names no limit of its own has none at all. The first call here does
    // RSA-2048 generation plus a self-signed certificate; every call after
    // costs three transactions and a vault decrypt. Sixty consecutive
    // unauthenticated 200s is a denial-of-service primitive anyone can aim at
    // any tenant by name.
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      codes.push((await fetchMetadata()).statusCode);
    }
    // The default is ten per address per minute, and `buildTestApp` does not
    // override it. Asserting the shape rather than the exact number, so a
    // deployment that raises the default does not break the test — but the
    // limit has to bite somewhere.
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes[0]).toBe(200);
    expect(codes.at(-1)).toBe(429);
  });

  it('creates the tenant SAML key when a service provider is configured, without any metadata fetch', async () => {
    // The seam. `completeSso` only ever calls `loadActiveKey`, and until this
    // was fixed `ensureActiveKey` existed at exactly one call site — the
    // metadata handler — with nothing enforcing that anybody ever reached it.
    // An administrator who configured a service provider and never fetched
    // metadata on that tenant's host had every first sign-in dead-end at 409
    // `saml-no-key`, with nothing self-healing it.
    const applicationId = await withTenant(ctx.tenantId, async (tx) => {
      const application = await createApplication(tx, {
        name: 'CRM', slug: 'crm', type: 'saml',
      });
      return application.id;
    });

    const before = await withTenant(ctx.tenantId, (tx) =>
      tx.signingKey.findMany({ where: { kind: 'saml' } }),
    );
    expect(before).toHaveLength(0);

    await saveSamlConfig(ctx.tenantId, applicationId, samlConfig(), samlKeyOptions);

    const after = await withTenant(ctx.tenantId, (tx) =>
      tx.signingKey.findMany({ where: { kind: 'saml' } }),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.certificate).not.toBeNull();

    // And a second write does not mint a second key.
    await saveSamlConfig(
      ctx.tenantId, applicationId, samlConfig({ allowIdpInitiated: true }), samlKeyOptions,
    );
    const again = await withTenant(ctx.tenantId, (tx) =>
      tx.signingKey.findMany({ where: { kind: 'saml' } }),
    );
    expect(again).toHaveLength(1);
    expect(again[0]!.kid).toBe(after[0]!.kid);
  });

  /**
   * UNAUTHENTICATED, so a 500 here is a stack trace in the log for anybody who
   * can reach the host and type a URL. The comment above this handler already
   * claimed the parameter was "validated so a mistyped id is a 404 rather than a
   * document naming an application that does not exist" -- it was cast, and
   * Prisma raised on the malformed uuid before the 404 branch was reached.
   */
  it('answers 400 for a metadata path that is not a uuid', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/saml/metadata/not-a-uuid',
      headers: { host: TEST_HOST },
    });
    expect(res.statusCode).toBe(400);
  });
});
