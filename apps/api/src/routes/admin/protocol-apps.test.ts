import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../../test-support.js';

const PASSWORD = 'correct horse battery staple';

/** Hashed once for the file, outside every transaction. Argon2id is slow. */
const PASSWORD_HASH = await hashPassword(PASSWORD);

const CERT_BODY =
  'MIIByjCCATOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlsb2NhbGhvc3Q=';
const PEM = `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n-----END CERTIFICATE-----\n`;

const SP_METADATA = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example.test/metadata">
  <SPSSODescriptor AuthnRequestsSigned="true" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${CERT_BODY}</X509Certificate></X509Data></KeyInfo>
    </KeyDescriptor>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/slo"/>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService index="0" isDefault="true" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs"/>
    <AssertionConsumerService index="1" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs2"/>
  </SPSSODescriptor>
</EntityDescriptor>`;

/** The same document with the KeyDescriptor removed. */
const SP_METADATA_UNSIGNED = SP_METADATA.replace(
  /<KeyDescriptor[\s\S]*?<\/KeyDescriptor>/,
  '',
);

type App = Awaited<ReturnType<typeof buildTestApp>>;

let ctx: App;
let adminCookie: string;
let portalCookie: string;

/**
 * Signs in, elevates, and returns both cookies.
 *
 * Parameterised on the app rather than on a module-level `ctx`, because two
 * cases build a second app with a different environment and need an
 * administrative session inside *its* tenant.
 */
async function adminSession(app: App): Promise<{ admin: string; portal: string }> {
  await withTenant(app.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Ada',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Owner', ALL_PERMISSIONS);
    await assignRole(tx, user.id, role.id);
  });

  const login = await app.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: app.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const portal = login.cookies.find((c) => c.name === 'syntra_session')!.value;

  const elevated = await app.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: app.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  return {
    admin: elevated.cookies.find((c) => c.name === 'syntra_session')!.value,
    portal,
  };
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  ({ admin: adminCookie, portal: portalCookie } = await adminSession(ctx));
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  app: App = ctx,
  cookie: string = adminCookie,
) => {
  const headers = { host: TEST_HOST, cookie: `syntra_session=${cookie}` };
  // Two calls rather than a spread: `exactOptionalPropertyTypes` will not let
  // a possibly-absent payload be handed to inject as `object | undefined`.
  return body === undefined
    ? app.app.inject({ method, url, headers })
    : app.app.inject({ method, url, headers, payload: body as object });
};

const get = (url: string, app?: App, cookie?: string) =>
  call('GET', url, undefined, app, cookie);
const post = (url: string, body: unknown, app?: App, cookie?: string) =>
  call('POST', url, body, app, cookie);
const put = (url: string, body: unknown, app?: App, cookie?: string) =>
  call('PUT', url, body, app, cookie);

const newApplication = async (
  fields: Record<string, unknown>,
  app?: App,
  cookie?: string,
): Promise<string> => {
  const created = await post('/api/admin/applications', fields, app, cookie);
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
};

const samlApplication = (slug: string, app?: App, cookie?: string) =>
  newApplication({ name: slug.toUpperCase(), slug, type: 'saml' }, app, cookie);

const oidcApplication = (slug: string) =>
  newApplication({
    name: slug.toUpperCase(),
    slug,
    type: 'oidc',
    // An OIDC application is launched by sending the browser to the relying
    // party's own start address, so it needs one.
    launchUrl: `https://${slug}.example.test/start`,
  });

const SP = {
  spEntityId: 'https://sp.example.test/metadata',
  acsUrls: ['https://sp.example.test/acs'],
  defaultAcsUrl: 'https://sp.example.test/acs',
  spCertificates: [PEM],
};

describe('admin protocol configuration', () => {
  it('registers a SAML application and reads the configuration back', async () => {
    const applicationId = await samlApplication('crm');

    const res = await put(`/api/admin/applications/${applicationId}/saml`, SP);
    expect(res.statusCode).toBe(200);
    expect(res.json().acsUrls).toEqual(['https://sp.example.test/acs']);

    // Ruling A2-10. Nothing in the request said anything about signing, and
    // the answer is the safe one. The plan drafted this schema with
    // `.default(false)`, which would have made both the service default and
    // the column default unreachable from the console — a security default
    // that is inert is not a default.
    expect(res.json().wantAuthnRequestsSigned).toBe(true);

    const readBack = await get(`/api/admin/applications/${applicationId}/saml`);
    expect(readBack.statusCode).toBe(200);
    expect(readBack.json().spEntityId).toBe('https://sp.example.test/metadata');
  });

  it('establishes the tenant SAML signing key when a configuration is written', async () => {
    const applicationId = await samlApplication('crm');
    await put(`/api/admin/applications/${applicationId}/saml`, SP);

    // Before commit 5b67bb9 the key was created only by whoever first fetched
    // /saml/metadata on the tenant's own host, so a service provider could be
    // configured and every sign-in then dead-ended at 409 `saml-no-key`.
    // Read through withTenant: a bare `prisma` read is outside the tenant
    // transaction and row-level security answers it with nothing, so the
    // assertion would hold whether or not the key exists.
    const keys = await withTenant(ctx.tenantId, (tx) =>
      tx.signingKey.findMany({ where: { kind: 'saml', status: 'active' } }),
    );
    expect(keys).toHaveLength(1);
  });

  it('refuses to require signed requests with nothing to check them against', async () => {
    const applicationId = await samlApplication('crm');
    const res = await put(`/api/admin/applications/${applicationId}/saml`, {
      spEntityId: 'https://sp.example.test/metadata',
      acsUrls: ['https://sp.example.test/acs'],
    });
    expect(res.statusCode).toBe(400);

    // Turning it off is a posture an administrator may choose — explicitly.
    const explicit = await put(`/api/admin/applications/${applicationId}/saml`, {
      spEntityId: 'https://sp.example.test/metadata',
      acsUrls: ['https://sp.example.test/acs'],
      wantAuthnRequestsSigned: false,
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().wantAuthnRequestsSigned).toBe(false);
  });

  it('refuses a javascript: ACS URL', async () => {
    const applicationId = await samlApplication('x');
    const res = await put(`/api/admin/applications/${applicationId}/saml`, {
      ...SP,
      acsUrls: ['javascript:alert(1)'],
      defaultAcsUrl: null,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an empty ACS allowlist', async () => {
    const applicationId = await samlApplication('y');
    const res = await put(`/api/admin/applications/${applicationId}/saml`, {
      ...SP,
      acsUrls: [],
      defaultAcsUrl: null,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a default ACS URL that is not on the allowlist', async () => {
    const applicationId = await samlApplication('z');
    const res = await put(`/api/admin/applications/${applicationId}/saml`, {
      ...SP,
      defaultAcsUrl: 'https://elsewhere.test/acs',
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses protocol configuration on an application of the other type', async () => {
    const bookmark = await newApplication({
      name: 'Handbook',
      slug: 'handbook',
      launchUrl: 'https://handbook.example.test/',
    });
    expect((await put(`/api/admin/applications/${bookmark}/saml`, SP)).statusCode).toBe(409);

    const saml = await samlApplication('crm');
    const res = await put(`/api/admin/applications/${saml}/oidc`, {
      clientId: 'crm',
      redirectUris: ['https://crm.example.test/cb'],
    });
    expect(res.statusCode).toBe(409);
  });

  it('imports service-provider metadata into the allowlist', async () => {
    const applicationId = await samlApplication('m');
    const res = await post(`/api/admin/applications/${applicationId}/saml/import`, {
      xml: SP_METADATA,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().acsUrls).toEqual([
      'https://sp.example.test/acs',
      'https://sp.example.test/acs2',
    ]);
    expect(res.json().spEntityId).toBe('https://sp.example.test/metadata');
    expect(res.json().sloUrl).toBe('https://sp.example.test/slo');
    expect(res.json().spCertificates[0]).toContain('BEGIN CERTIFICATE');
    expect(res.json().wantAuthnRequestsSigned).toBe(true);
  });

  it('leaves the decisions an administrator made alone when metadata is re-imported', async () => {
    const applicationId = await samlApplication('m');
    await post(`/api/admin/applications/${applicationId}/saml/import`, { xml: SP_METADATA });

    const configured = await put(`/api/admin/applications/${applicationId}/saml`, {
      ...SP,
      acsUrls: ['https://sp.example.test/acs', 'https://sp.example.test/acs2'],
      allowIdpInitiated: true,
      assertionLifetimeMs: 120_000,
      nameIdClaim: 'employeeId',
    });
    expect(configured.json().allowIdpInitiated).toBe(true);

    // `upsertSamlConfig` writes every column, so an import that handed it a
    // fresh record would silently turn identity-provider-initiated sign-in
    // back off and reset the lifetime. The import reads the row first.
    const reimported = await post(
      `/api/admin/applications/${applicationId}/saml/import`,
      { xml: SP_METADATA },
    );
    expect(reimported.statusCode).toBe(200);
    expect(reimported.json().allowIdpInitiated).toBe(true);
    expect(reimported.json().assertionLifetimeMs).toBe(120_000);
    expect(reimported.json().nameIdClaim).toBe('employeeId');
  });

  it('will not lower the signing posture from a document, only from a decision', async () => {
    const applicationId = await samlApplication('m');

    const refused = await post(`/api/admin/applications/${applicationId}/saml/import`, {
      xml: SP_METADATA_UNSIGNED,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('wantAuthnRequestsSigned');

    const nothingWritten = await withTenant(ctx.tenantId, (tx) =>
      tx.samlConfig.findMany(),
    );
    expect(nothingWritten).toHaveLength(0);

    const accepted = await post(`/api/admin/applications/${applicationId}/saml/import`, {
      xml: SP_METADATA_UNSIGNED,
      wantAuthnRequestsSigned: false,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().wantAuthnRequestsSigned).toBe(false);
  });

  it('refuses to fetch metadata from an address inside the deployment', async () => {
    // buildTestApp allows private addresses by default so the federation
    // suites can run against a loopback stub; this one turns it back off,
    // which is the shipped default.
    const strict = await buildTestApp({ env: { OUTBOUND_ALLOW_PRIVATE: 'false' } });
    await strict.app.ready();
    const strictCookie = (await adminSession(strict)).admin;
    const applicationId = await samlApplication('s', strict, strictCookie);

    const res = await post(
      `/api/admin/applications/${applicationId}/saml/import`,
      { url: 'http://127.0.0.1:9/metadata' },
      strict,
      strictCookie,
    );
    expect(res.statusCode).toBe(502);
    // Named, so an operator can see which address was refused and decide.
    expect(res.body).toContain('127.0.0.1');

    // And nothing was written from it. Through withTenant: row-level security
    // answers a bare `prisma` read with nothing whatever the table holds, so
    // that version of this assertion passes without proving anything.
    const configured = await withTenant(strict.tenantId, (tx) =>
      tx.samlConfig.findMany(),
    );
    expect(configured).toHaveLength(0);
  });

  it('returns an OIDC client secret exactly once', async () => {
    const applicationId = await oidcApplication('api');

    const first = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'api',
      redirectUris: ['https://api.example.test/cb'],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().clientSecret).toMatch(/.{20,}/);

    // Reading it back never yields the secret again — spec section 12.
    const read = await get(`/api/admin/applications/${applicationId}/oidc`);
    expect(read.json().clientSecret).toBeUndefined();
    expect(JSON.stringify(read.json())).not.toContain('clientSecretHash');

    // Updating without asking for rotation does not mint a new one.
    const update = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'api',
      redirectUris: ['https://api.example.test/cb', 'https://api.example.test/cb2'],
    });
    expect(update.json().clientSecret).toBeNull();

    const rotated = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'api',
      redirectUris: ['https://api.example.test/cb'],
      rotateSecret: true,
    });
    expect(rotated.json().clientSecret).toMatch(/.{20,}/);
    expect(rotated.json().clientSecret).not.toBe(first.json().clientSecret);
  });

  it('refuses client_credentials as a grant type, and takes it only as its own flag', async () => {
    const applicationId = await oidcApplication('machine');

    // A2-5 condition 1: it cannot arrive by editing the grants array.
    const smuggled = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'm',
      redirectUris: [],
      grantTypes: ['client_credentials'],
    });
    expect(smuggled.statusCode).toBe(400);

    const enabled = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'm',
      redirectUris: [],
      grantTypes: [],
      clientCredentialsEnabled: true,
      scopes: ['reports.read'],
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().clientCredentialsEnabled).toBe(true);
  });

  it('refuses a client credentials client registered for a user scope', async () => {
    const applicationId = await oidcApplication('machine2');
    for (const scope of ['openid', 'profile', 'email', 'offline_access']) {
      const res = await put(`/api/admin/applications/${applicationId}/oidc`, {
        clientId: 'n',
        redirectUris: [],
        grantTypes: [],
        clientCredentialsEnabled: true,
        scopes: ['reports.read', scope],
      });
      // A2-5 condition 3, refused at the console rather than only at the
      // token endpoint, so the configuration cannot exist in the first place.
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a client credentials client that authenticates with nothing', async () => {
    const applicationId = await oidcApplication('machine3');

    // RFC 6749 section 4.4, and the ground ruling A2-5 was granted on: the
    // control on this grant is the client secret. `none` means there is no
    // secret, so an administrator saving this would be publishing a token
    // endpoint that answers anyone who knows the client id -- and be told
    // nothing about it.
    const open = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'open',
      redirectUris: [],
      grantTypes: [],
      clientCredentialsEnabled: true,
      scopes: ['reports.read'],
      tokenEndpointAuthMethod: 'none',
    });
    expect(open.statusCode).toBe(400);

    // The positive control: `none` is not being refused across the board, and
    // neither is this machine client. Only the combination is.
    const publicClient = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'open',
      redirectUris: ['https://spa.acme.test/cb'],
      tokenEndpointAuthMethod: 'none',
    });
    expect(publicClient.statusCode).toBe(200);

    const confidential = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'open',
      redirectUris: [],
      grantTypes: [],
      clientCredentialsEnabled: true,
      scopes: ['reports.read'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    expect(confidential.statusCode).toBe(200);
  });

  it('refuses a wildcard or prefix redirect URI', async () => {
    const applicationId = await oidcApplication('w');
    for (const bad of [
      'https://*.example.test/cb',
      'https://api.example.test/cb#x',
      'javascript:x',
      'https://user:pass@api.example.test/cb',
    ]) {
      const res = await put(`/api/admin/applications/${applicationId}/oidc`, {
        clientId: 'w',
        redirectUris: [bad],
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('never returns an upstream client secret once written', async () => {
    const created = await post('/api/admin/upstreams', {
      slug: 'entra',
      name: 'Entra ID',
      protocol: 'oidc',
      issuerUrl: 'https://login.example/entra',
      clientId: 'syntra',
      clientSecret: 'super-secret-value',
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain('super-secret-value');

    const list = await get('/api/admin/upstreams');
    expect(JSON.stringify(list.json())).not.toContain('super-secret-value');
    expect(JSON.stringify(list.json())).not.toContain('clientSecretName');

    // The audit event must not carry it either — the log is the one place a
    // secret leaks to that nobody thinks to check.
    const audit = await get('/api/admin/audit');
    expect(JSON.stringify(audit.json())).not.toContain('super-secret-value');
  });

  it('refuses every protocol route to a portal session', async () => {
    const applicationId = await samlApplication('p');
    const res = await put(
      `/api/admin/applications/${applicationId}/saml`,
      SP,
      ctx,
      portalCookie,
    );
    // A portal session is refused by requireSession('admin') before any
    // permission is even looked up.
    expect(res.statusCode).toBe(403);

    expect((await get('/api/admin/upstreams', ctx, portalCookie)).statusCode).toBe(403);
    expect(
      (await post('/api/admin/upstreams', { slug: 'x', name: 'X', protocol: 'saml' }, ctx, portalCookie))
        .statusCode,
    ).toBe(403);
  });

  it('drops the cached provider when a client changes', async () => {
    const applicationId = await oidcApplication('c');
    await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'c',
      redirectUris: ['https://c.example.test/cb'],
    });
    // Discovery works, which means a Provider was built.
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/oidc/.well-known/openid-configuration',
      headers: { host: TEST_HOST },
    });
    expect(before.statusCode).toBe(200);

    await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'c',
      redirectUris: ['https://c.example.test/cb', 'https://c.example.test/cb2'],
    });
    // The new redirect URI is honoured without a restart, which is only true
    // if the write invalidated the cache — clients are loaded once at
    // construction.
    const authorize = await ctx.app.inject({
      method: 'GET',
      url: `/oidc/auth?client_id=c&response_type=code&scope=openid&redirect_uri=${encodeURIComponent(
        'https://c.example.test/cb2',
      )}&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256&state=s`,
      headers: { host: TEST_HOST },
    });
    expect(authorize.statusCode).not.toBe(400);
  });

  it('records a claim mapping and gives it back on both protocols', async () => {
    const applicationId = await samlApplication('crm');
    const created = await post(`/api/admin/applications/${applicationId}/claims`, {
      protocol: 'saml',
      claimName: 'department',
      sourceKind: 'contract',
      sourceField: 'department',
    });
    expect(created.statusCode).toBe(201);

    const listed = await get(`/api/admin/applications/${applicationId}/claims`);
    expect(listed.json().saml).toHaveLength(1);
    expect(listed.json().oidc).toHaveLength(0);

    const removed = await call(
      'DELETE',
      `/api/admin/applications/${applicationId}/claims/${created.json().id}`,
    );
    expect(removed.statusCode).toBe(204);
    expect((await get(`/api/admin/applications/${applicationId}/claims`)).json().saml)
      .toHaveLength(0);
  });

  it('refuses a claim mapping whose source names no field', async () => {
    const applicationId = await samlApplication('crm');
    const res = await post(`/api/admin/applications/${applicationId}/claims`, {
      protocol: 'saml',
      claimName: 'department',
      sourceKind: 'contract',
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * The routing half of the console.
 *
 * Task 14 added the `federate` outcome, its column, its service validation and
 * its evaluator, and left `policyOutcome` in `packages/contracts` naming four
 * outcomes — so until now no routing rule could be written through the API at
 * all, and the feature was unreachable from anything but a seed script.
 */
describe('federate policy rules', () => {
  const upstream = async () => {
    const created = await post('/api/admin/upstreams', {
      slug: 'entra',
      name: 'Entra ID',
      protocol: 'oidc',
      issuerUrl: 'https://login.example/entra',
      clientId: 'syntra',
      clientSecret: 'secret-value',
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  };

  it('writes a routing rule and reads it back as a route, not a rule', async () => {
    const upstreamIdpId = await upstream();
    const created = await post('/api/admin/policy/rules', {
      name: 'Acme staff go to Entra',
      outcome: 'federate',
      upstreamIdpId,
      loginDomains: ['acme.test'],
    });
    expect(created.statusCode).toBe(201);

    const policy = await get('/api/admin/policy');
    expect(policy.json().routes).toHaveLength(1);
    expect(policy.json().routes[0]).toMatchObject({
      upstreamIdpId,
      loginDomains: ['acme.test'],
    });
    // A federate row must never reach evaluatePolicy: it would be narrowed to
    // `deny` and refuse every sign-in in the tenant from position 1.
    expect(policy.json().rules).toHaveLength(0);
  });

  it('refuses a federate rule that names no upstream', async () => {
    const res = await post('/api/admin/policy/rules', {
      name: 'Nowhere',
      outcome: 'federate',
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses conditions a routing rule could not evaluate', async () => {
    const upstreamIdpId = await upstream();
    const withGroup = await post('/api/admin/policy/rules', {
      name: 'Nurses go to Entra',
      outcome: 'federate',
      upstreamIdpId,
      groupIds: ['00000000-0000-4000-8000-000000000001'],
    });
    // The upstream is chosen before anybody is identified, so there is no user
    // to look a group up for.
    expect(withGroup.statusCode).toBe(400);

    const withContract = await post('/api/admin/policy/rules', {
      name: 'Care goes to Entra',
      outcome: 'federate',
      upstreamIdpId,
      contractField: 'department',
      contractValues: ['Care'],
    });
    expect(withContract.statusCode).toBe(400);
  });

  it('refuses an upstream or a login domain on a rule that is not federate', async () => {
    const upstreamIdpId = await upstream();
    const named = await post('/api/admin/policy/rules', {
      name: 'Allow',
      outcome: 'allow',
      upstreamIdpId,
    });
    expect(named.statusCode).toBe(400);

    const domains = await post('/api/admin/policy/rules', {
      name: 'Allow',
      outcome: 'allow',
      loginDomains: ['acme.test'],
    });
    expect(domains.statusCode).toBe(400);
  });

  it('refuses federate as the tenant default', async () => {
    const res = await put('/api/admin/policy/default', { outcome: 'federate' });
    // A fallback that federates would send every unmatched sign-in — including
    // one with no login typed — to an upstream.
    expect(res.statusCode).toBe(400);
  });
});
