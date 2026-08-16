import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { createApplication, upsertOidcClient } from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let boundarySecret: string;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  // A registered client, so the token-endpoint case below can present real
  // credentials in the body. Without one, oidc-provider answers every token
  // request `no client authentication mechanism provided` whether the body
  // reached it or not, and the case would discriminate nothing.
  boundarySecret = await withTenant(ctx.tenantId, async (tx) => {
    const application = await createApplication(tx, {
      name: 'Boundary',
      slug: 'boundary',
      type: 'oidc',
    });
    const { clientSecret } = await upsertOidcClient(tx, application.id, {
      clientId: 'boundary',
      redirectUris: ['https://boundary.acme.test/cb'],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code'],
      scopes: ['openid'],
      requirePkce: true,
      clientCredentialsEnabled: false,
      // `client_secret_post` deliberately: it puts the client id, the client
      // secret and the grant type all in the body, so the case below fails if
      // any of the body fails to reach oidc-provider.
      tokenEndpointAuthMethod: 'client_secret_post',
      idTokenSignedResponseAlg: 'RS256',
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 0,
    });
    return clientSecret!;
  });
});

describe('the body-parsing boundary', () => {
  it('has no urlencoded parser at the root instance', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. `/oidc/*` hands oidc-provider the raw
    // stream, and oidc-provider reads the body itself. A urlencoded parser at
    // the root drains that stream for every OIDC endpoint. Three plugins
    // legitimately parse form bodies — the SAML IdP, the OIDC token endpoint
    // and federation — and each registers its own inside its own scope;
    // Fastify's encapsulation is what keeps them there.
    //
    // Fastify core registers parsers only for application/json and text/plain,
    // so this is false unless somebody added one.
    expect(ctx.app.hasContentTypeParser('application/x-www-form-urlencoded')).toBe(false);
    // And the encapsulated ones are still absent from the root, which is the
    // same statement from the other direction.
    expect(ctx.app.hasContentTypeParser('application/json')).toBe(true);
  });

  it('builds at all — a duplicate parser registration fails at boot', async () => {
    // Registering `@fastify/formbody` at the root makes the SAML and token
    // plugins' own `addContentTypeParser` throw FST_ERR_CTP_ALREADY_PRESENT
    // while the app is being built. Asserting the build resolves is what turns
    // that from a runtime surprise into a failed test.
    await expect(buildTestApp()).resolves.toBeDefined();
  });

  it('delivers the token endpoint body to oidc-provider, not a drained stream', async () => {
    // The discriminator, measured. The body carries the client id, the client
    // secret and the grant type. With it replayed, oidc-provider authenticates
    // the client and then rejects the grant type: `unsupported_grant_type`.
    // Without the replay it sees an empty body and answers `invalid_request`
    // — either `no client authentication mechanism provided` (nothing to
    // authenticate with) or `failed to parse the request body` (fewer bytes
    // than content-length). Asserting the first AND denying both of the second
    // is what distinguishes "the replay works" from "the route happened to
    // return 400".
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/oidc/token',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        grant_type: 'bogus',
        client_id: 'boundary',
        client_secret: boundarySecret,
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('unsupported_grant_type');
    expect(body.error_description ?? '').not.toContain('client authentication');
    expect(body.error_description ?? '').not.toContain('request body');
  });

  it('routes an OIDC path to oidc-provider at all, proving the mount prefix is stripped', async () => {
    // Without the prefix strip, oidc-provider's router matches nothing and
    // answers a bare Koa 404 with the text "Not Found" for every route here.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/oidc/.well-known/openid-configuration',
      headers: { host: TEST_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toBe('Not Found');
    expect(JSON.parse(res.body).issuer).toBe(`http://${TEST_HOST}/oidc`);
  });

  it('lets a form-encoded POST reach the provider on the catch-all', async () => {
    // The discovery document advertises `<issuer>/token/revocation` and
    // `<issuer>/token/introspection`, and neither is the exact `/token` route
    // the token plugin owns — so both land on the catch-all, which had no
    // parser for `application/x-www-form-urlencoded` and therefore answered
    // 415 to every client before the handler ran. Advertising an endpoint that
    // refuses every request is worse than not advertising it.
    //
    // The parser there parses nothing: it hands the stream straight back so
    // `request.raw` is still unread when oidc-provider takes the socket. What
    // this asserts is that the request got as far as oidc-provider *and* that
    // oidc-provider could read the body — a 400 naming the client is an answer
    // from the provider; 415 is Fastify refusing in front of it.
    for (const path of ['/oidc/token/revocation', '/oidc/token/introspection']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: path,
        headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          token: 'nonsense',
          client_id: 'boundary',
          client_secret: boundarySecret,
        }).toString(),
      });
      expect(res.statusCode, path).not.toBe(415);
      expect(res.statusCode, path).not.toBe(404);
      // And the answer is oidc-provider's, in OAuth's own shape.
      expect(JSON.parse(res.body), path).toHaveProperty('error');
    }
  });

  it('cannot authenticate a client on those endpoints, and says so plainly', async () => {
    // The counterpart to the case above, written down rather than discovered.
    // Client authentication for `/token` is Syntra's own — constant-time,
    // against the stored SHA-256 hash — and oidc-provider is handed a
    // *placeholder* secret it never sees the real value of. That is what makes
    // `/token` safe, and it is also why every other client-authenticated
    // endpoint answers `invalid_client` to a client presenting its real
    // secret: the provider is checking against a value nobody has.
    //
    // Revocation and introspection are outside spec section 7 and are not
    // wired to Syntra's client authentication. The README says so; this says
    // so where somebody changing the token endpoint will read it.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/oidc/token/revocation',
      headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        token: 'nonsense',
        client_id: 'boundary',
        client_secret: boundarySecret,
      }).toString(),
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_client');
  });

  it('parses a form body inside the SAML plugin, where one is registered', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/saml/sso',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ SAMLRequest: '' }).toString(),
    });
    // The handler read `request.body` and found an empty SAMLRequest. A 415
    // would mean no parser; a 500 would mean `request.body` was undefined.
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(415);
  });
});
