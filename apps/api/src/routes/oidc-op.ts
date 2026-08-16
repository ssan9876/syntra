import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { createPrivateKey } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import { exportJWK } from 'jose';
import {
  collectSubjectFacts,
  ensureActiveKey,
  listClaimMappings,
  listOidcClients,
  localMasterKeyProvider,
  publishedKeys,
  readSigningKeyPem,
  resolveClaims,
} from '@syntra/core';
import { providerFor } from '@syntra/protocols';
import { assertProtocolHost, tenantProtocolIdentity } from './protocol-identity.js';

export interface OidcRouteOptions {
  publicUrl: string;
  masterKey: Buffer;
  sessionSecret: string;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
}

/** The path everything OIDC is mounted under, and the prefix stripped below. */
export const OIDC_MOUNT = '/oidc';

/**
 * The `client_secret` every client's metadata carries into `oidc-provider`.
 *
 * Syntra holds only a SHA-256 hash of the real secret, so it cannot hand
 * oidc-provider the value the library would need for its own client
 * authentication (`lib/shared/client_auth.js` compares the presented secret
 * against `client.clientSecret` with `constantEquals`). The token endpoint
 * therefore authenticates the client itself, against the stored hash and in
 * constant time, and then rewrites the credential it forwards to carry this
 * placeholder — so oidc-provider's own check passes on a request Syntra has
 * already authenticated, and fails on one it has not.
 *
 * Exported so `oidc-token.ts` substitutes exactly what `loadClients` below
 * registered. Two literals that had to agree would eventually stop agreeing,
 * and the symptom would be `invalid_client` on every token exchange.
 */
export const PROVIDER_CLIENT_SECRET = 'syntra-verified';

/**
 * The request object `oidc-provider` is handed.
 *
 * Two adaptations, both required, both established by spike:
 *
 * 1. **`url` has the mount prefix removed.** oidc-provider's router registers
 *    `/token`, `/auth`, `/jwks` and matches them against `ctx.path`
 *    (`lib/helpers/initialize_app.js`). Handing it `/oidc/token` unchanged
 *    returns a bare Koa 404 for every OIDC route.
 * 2. **`originalUrl` keeps the prefix.** `ctx.oidc.urlFor` derives the mount
 *    path as `originalUrl.substring(0, originalUrl.indexOf(request.url))`
 *    (`lib/helpers/oidc_context.js:86`). Strip the prefix without this and the
 *    discovery document advertises `http://host/token` — the prefix silently
 *    vanishes from every URL a relying party consumes.
 *
 * `body` is non-null only for the token endpoint, which had to parse the form
 * to check the client secret and the authorization decision first. A consumed
 * stream cannot be read again, so the bytes are replayed through a
 * `PassThrough` carrying the properties Koa reads. Everything else hands
 * oidc-provider the untouched raw request.
 *
 * `headers` overrides the ones the request arrived with, and is honoured only
 * on the replay path. The token endpoint uses it to present
 * `PROVIDER_CLIENT_SECRET` in place of the secret the client sent, since
 * oidc-provider authenticates the client a second time against the metadata it
 * was given. Whoever changes the replayed bytes must change `content-length`
 * with them: oidc-provider reads the body itself and rejects a request whose
 * size does not match the header (`lib/shared/selective_body.js`).
 */
export function requestForProvider(
  raw: IncomingMessage,
  body: Buffer | null,
  headers: IncomingHttpHeaders = raw.headers,
): IncomingMessage {
  const originalUrl = raw.url ?? '/';
  const url = originalUrl.startsWith(OIDC_MOUNT)
    ? originalUrl.slice(OIDC_MOUNT.length) || '/'
    : originalUrl;

  if (body === null) return Object.assign(raw, { url, originalUrl });

  const replay = new PassThrough();
  replay.end(body);
  return Object.assign(replay, {
    method: raw.method,
    headers,
    httpVersion: raw.httpVersion,
    httpVersionMajor: raw.httpVersionMajor,
    httpVersionMinor: raw.httpVersionMinor,
    rawHeaders: raw.rawHeaders,
    socket: raw.socket,
    connection: raw.socket,
    trailers: {},
    rawTrailers: [],
    complete: false,
    url,
    originalUrl,
  }) as unknown as IncomingMessage;
}

/**
 * The tenant's `Provider`, built on first use and cached.
 *
 * The issuer comes from `tenantProtocolIdentity` and the request's Host is
 * checked against it first. `oidc-provider` stamps the issuer into every `iss`
 * claim and into the discovery document, and a relying party validates it — so
 * deriving it from the header would let an attacker choose the value their own
 * token is checked against.
 */
export async function oidcProviderFor(
  request: FastifyRequest,
  options: OidcRouteOptions,
): Promise<Provider> {
  const tenant = await request.db((tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
  );
  const identity = tenantProtocolIdentity(tenant, options.publicUrl);
  assertProtocolHost(request, identity);

  const tenantId = request.tenantId;
  const provider = localMasterKeyProvider(options.masterKey);

  return providerFor(tenantId, identity.issuer, {
    findAccount: async (accountId, clientId) => {
      // The user store stays Syntra's. This is the only thing oidc-provider
      // ever learns about a person, and it learns it from the same claim
      // engine SAML uses.
      const result = await request.db(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: accountId } });
        if (!user || user.status !== 'active') return null;
        const oidcClient = clientId
          ? await tx.oidcClient.findFirst({ where: { clientId } })
          : null;
        const facts = await collectSubjectFacts(tx, accountId);
        const mappings = oidcClient
          ? await listClaimMappings(tx, oidcClient.applicationId, 'oidc')
          : [];
        return { user, facts, mappings };
      });
      if (!result) return null;

      const claims: Record<string, unknown> = {};
      for (const claim of resolveClaims(result.mappings, result.facts, 'oidc')) {
        claims[claim.name] = claim.values.length === 1 ? claim.values[0] : claim.values;
      }
      // Two claims are always present because a relying party has nowhere else
      // to get them; everything else is what the tenant mapped.
      claims.preferred_username ??= result.user.login;
      claims.name ??= result.user.displayName;
      return { accountId, claims };
    },

    loadClients: async () => {
      const clients = await listOidcClients(tenantId);
      return clients.map((c) => ({
        client_id: c.clientId,
        // The placeholder. `registerOidcTokenRoutes` performs client
        // authentication against the stored SHA-256 hash in constant time
        // before oidc-provider sees the request, and then substitutes this
        // value into the credential it forwards — oidc-provider compares the
        // metadata field itself, and putting the real secret here would mean
        // holding it recoverably.
        client_secret: PROVIDER_CLIENT_SECRET,
        redirect_uris: c.redirectUris,
        post_logout_redirect_uris: c.postLogoutRedirectUris,
        // Derived, never read straight off `grantTypes`. The admin API refuses
        // `client_credentials` there, so the flag is the only way it can be on
        // — one place to look when asking which clients bypass authorize().
        grant_types: c.clientCredentialsEnabled
          ? [...c.grantTypes, 'client_credentials']
          : c.grantTypes,
        response_types: c.grantTypes.includes('authorization_code') ? ['code'] : [],
        scope: c.scopes.join(' '),
        token_endpoint_auth_method: c.tokenEndpointAuthMethod,
        id_token_signed_response_alg: c.idTokenSignedResponseAlg,
      }));
    },

    // The PRIVATE JWKs, because oidc-provider signs with them. The published
    // `/oidc/jwks` route below serves only the public halves, and a test
    // asserts no `d` appears there. Both published keys are handed over, so a
    // token signed with the outgoing key during a rollover still verifies.
    jwks: async () => {
      await ensureActiveKey(tenantId, provider, 'oidc');
      const published = await publishedKeys(tenantId, 'oidc');
      const keys: Record<string, unknown>[] = [];
      for (const key of published) {
        const pem = await readSigningKeyPem(tenantId, provider, 'oidc', key.kid);
        if (!pem) continue;
        const jwk = (await exportJWK(createPrivateKey(pem))) as Record<string, unknown>;
        keys.push({ ...jwk, kid: key.kid, alg: key.alg, use: 'sig' });
      }
      return { keys };
    },

    interactionUrl: (uid) => `${OIDC_MOUNT}/interaction/${uid}`,
    cookieKeys: [options.sessionSecret],
  });
}

export async function registerOidcRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  // Served by Syntra rather than by oidc-provider, so the Host check runs
  // first and so the published document contains only public key halves.
  app.get('/jwks', async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    assertProtocolHost(request, tenantProtocolIdentity(tenant, options.publicUrl));

    await ensureActiveKey(
      request.tenantId, localMasterKeyProvider(options.masterKey), 'oidc',
    );
    const keys = await publishedKeys(request.tenantId, 'oidc');
    return reply
      .type('application/jwk-set+json')
      .header('cache-control', 'public, max-age=300')
      .send({ keys: keys.map((key) => key.publicJwk) });
  });

  /**
   * Everything else — discovery, authorization, userinfo, revocation,
   * introspection, end_session — is oidc-provider's.
   *
   * `reply.hijack()` tells Fastify to stop managing the response; from that
   * point oidc-provider owns the socket. **This plugin registers no body
   * parser**, so the raw stream reaches oidc-provider untouched. Fastify core
   * parses only `application/json` and `text/plain`; the
   * `application/x-www-form-urlencoded` bodies these endpoints receive pass
   * through, and `oidc-boundary.test.ts` asserts nothing has added a parser at
   * the root.
   */
  app.all('/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const provider = await oidcProviderFor(request, options);
    reply.hijack();
    await provider.callback()(requestForProvider(request.raw, null), reply.raw);
  });
}
