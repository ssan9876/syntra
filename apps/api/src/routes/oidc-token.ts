import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  consumeAuthorizationDecision,
  findOidcClient,
  recordEvent,
  verifyClientSecret,
} from '@syntra/core';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import {
  oidcProviderFor,
  PROVIDER_CLIENT_SECRET,
  requestForProvider,
  type OidcRouteOptions,
} from './oidc-op.js';

/**
 * The fields Control 2 reads off a stored authorization code.
 *
 * `accountId`, `clientId` and `consumed` are all on the instance at runtime —
 * `consumed` because `lib/models/mixins/consumable.js` lists it in
 * `IN_PAYLOAD`, so `find()` restores it — but `@types/oidc-provider` 9.11.1
 * declares `consumed` on `RefreshToken` and `PushedAuthorizationRequest` and
 * omits it from `AuthorizationCode`, which is the one model that needs it
 * here. Narrowed in one place, and pinned by the contract block in
 * `oidc-token.test.ts` so the omission cannot become a wrong assumption.
 */
interface StoredCode {
  accountId?: unknown;
  clientId?: unknown;
  consumed?: unknown;
}

interface ClientCredentials {
  clientId: string;
  secret: string;
  /** Which mechanism carried them, because the substitution has to use it too. */
  via: 'basic' | 'post';
}

/**
 * The client credentials a token request presented, or null for a public
 * client authenticating with PKCE alone.
 *
 * Both `client_secret_basic` (the Authorization header) and
 * `client_secret_post` (a form field) are read, because a client may use
 * either and refusing the one a client happens to use is a support ticket.
 * RFC 6749 section 2.3.1 percent-encodes both halves of the Basic credential.
 */
function presentedCredentials(
  request: FastifyRequest,
  params: URLSearchParams,
): ClientCredentials | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index <= 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, index)),
      secret: decodeURIComponent(decoded.slice(index + 1)),
      via: 'basic',
    };
  }
  const clientId = params.get('client_id');
  const secret = params.get('client_secret');
  if (clientId === null || secret === null) return null;
  return { clientId, secret, via: 'post' };
}

/**
 * The request oidc-provider is handed, with the client secret replaced.
 *
 * oidc-provider authenticates the client a second time, against the
 * `client_secret` in the metadata it was built with
 * (`lib/shared/client_auth.js` → `Client#compareClientSecret`). Syntra stores
 * only a SHA-256 hash and therefore registered `PROVIDER_CLIENT_SECRET` there,
 * so the credential the client actually sent would fail that comparison and no
 * token exchange would ever complete. The substitution below is what closes
 * that gap, and it is safe in exactly one direction: it happens only after
 * `verifyClientSecret` returned true against the stored hash, so a request
 * Syntra did not authenticate never carries the placeholder.
 *
 * The mechanism is preserved rather than normalised. A client registered for
 * `client_secret_basic` that presents a form field — or the reverse — is
 * oidc-provider's to reject, and rewriting one into the other would take that
 * decision away from it.
 */
function substitutedRequest(
  headers: IncomingHttpHeaders,
  body: Buffer,
  params: URLSearchParams,
  credentials: ClientCredentials | null,
): { headers: IncomingHttpHeaders; body: Buffer } {
  if (credentials === null) return { headers, body };

  if (credentials.via === 'basic') {
    // RFC 6749 section 2.3.1: both halves percent-encoded before the base64.
    const encoded = Buffer.from(
      `${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(PROVIDER_CLIENT_SECRET)}`,
      'utf8',
    ).toString('base64');
    return { headers: { ...headers, authorization: `Basic ${encoded}` }, body };
  }

  const substituted = new URLSearchParams(params);
  substituted.set('client_secret', PROVIDER_CLIENT_SECRET);
  const replacement = Buffer.from(substituted.toString(), 'utf8');
  // `content-length` moves with the bytes. oidc-provider reads the body itself
  // and throws `request size did not match content length` otherwise, which
  // would surface as `invalid_request` on every post-authenticated client.
  return {
    headers: { ...headers, 'content-length': String(replacement.byteLength) },
    body: replacement,
  };
}

/**
 * The second of the two independent controls behind spec section 7's
 * chokepoint.
 *
 * The first is `syntraAuthorizePrompt`, which forces every authorization
 * request out to Syntra's interaction route. It is one deleted line in a file
 * whose purpose is not obvious, and it depends on `ctx.oidc.result` semantics
 * internal to `oidc-provider`. This one is in Syntra's own route, reads
 * Syntra's own table, and does not touch `oidc-provider`'s configuration at
 * all — so no single edit removes both, which is the whole point of having
 * two. `oidc-token.test.ts` mints a genuine authorization code with no
 * interaction behind it and asserts this refuses it.
 *
 * The ordering is deliberate. A code that is **unknown, expired or already
 * consumed** is handed to oidc-provider untouched, because its own replay
 * detection revokes the entire grant when a consumed code is presented a
 * second time — refusing here first would answer with the same status and lose
 * that revocation. Only a code that is live, and for which no decision exists,
 * is refused here.
 *
 * `refresh_token` and `client_credentials` are not checked. A refresh token
 * descends from a code that was checked, and re-checking would demand a fresh
 * interaction for every refresh. Client credentials authenticate a *client*
 * and involve no user, no session and no policy decision to bypass; the
 * control there is the client secret.
 */
async function refuseWithoutDecision(
  request: FastifyRequest,
  provider: Awaited<ReturnType<typeof oidcProviderFor>>,
  params: URLSearchParams,
): Promise<{ error: string; error_description: string } | null> {
  const code = params.get('code');
  if (code === null || code === '') return null;

  const stored = (await provider.AuthorizationCode.find(code)) as StoredCode | undefined;
  if (!stored || stored.consumed) return null;

  const accountId = stored.accountId;
  const clientId = stored.clientId;
  if (typeof accountId !== 'string' || typeof clientId !== 'string') return null;

  if (await consumeAuthorizationDecision(request.tenantId, accountId, clientId)) {
    return null;
  }

  await request.db((tx) =>
    recordEvent(tx, {
      actorUserId: accountId,
      action: 'oidc.decision_missing',
      targetType: 'User',
      targetId: accountId,
      outcome: 'failure',
      sourceIp: request.ip,
      payload: {
        clientId,
        reason: 'no live authorize() decision for this authorization code',
      },
    }),
  );

  return {
    error: 'invalid_grant',
    error_description: 'This authorization was not granted by this identity provider',
  };
}

/** The scopes a user token carries. A machine token may never carry one. */
const USER_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

/**
 * The client credentials arm.
 *
 * This grant issues a token with no `authorize()` decision behind it — the one
 * path in the product that does, accepted deliberately by ruling A2-5 because
 * it authenticates a client rather than a person. The exemption is only
 * defensible while it stays bounded, and these are the bounds:
 *
 * - The client must have been enabled for it explicitly. Checked here against
 *   Syntra's own row rather than relying on `oidc-provider`'s `grant_types`,
 *   which is derived from the same flag — two reads of one fact, so a bug in
 *   the derivation fails closed rather than opening the grant.
 * - The requested scopes must not include any a user token carries, so the
 *   result cannot be presented where a user token is accepted.
 * - Whatever is authorized is audited under its own action, so the set of
 *   tokens issued without a policy decision is enumerable.
 *
 * The event records that *Syntra* permitted issuance. `oidc-provider` may
 * still refuse afterwards for a protocol reason — an unregistered scope, a
 * malformed request — so the event means "this passed the checks that stand in
 * for a policy decision", which is exactly the question it exists to answer.
 */
async function guardClientCredentials(
  request: FastifyRequest,
  params: URLSearchParams,
): Promise<{ error: string; error_description: string } | null> {
  const clientId = presentedCredentials(request, params)?.clientId ?? params.get('client_id');
  if (clientId === null || clientId === '') {
    return { error: 'invalid_client', error_description: 'Client authentication failed' };
  }

  const record = await findOidcClient(request.tenantId, clientId);
  if (!record?.clientCredentialsEnabled) {
    return {
      error: 'unauthorized_client',
      error_description: 'This client is not enabled for the client credentials grant',
    };
  }

  const requested = (params.get('scope') ?? '').split(' ').filter((s) => s !== '');
  const overlap = requested.filter((s) => USER_SCOPES.has(s));
  if (overlap.length > 0) {
    return {
      error: 'invalid_scope',
      error_description: `A client credentials token may not carry ${overlap.join(', ')}`,
    };
  }

  await request.db((tx) =>
    recordEvent(tx, {
      // No user. That is the point, and a null actor is the honest record of
      // it rather than an invented service account.
      actorUserId: null,
      action: 'oidc.client_credentials_authorized',
      targetType: 'Application',
      targetId: record.applicationId,
      outcome: 'success',
      sourceIp: request.ip,
      payload: { clientId, scope: requested, noPolicyDecision: true },
    }),
  );
  return null;
}

/**
 * The token endpoint.
 *
 * Its own plugin because it is the one OIDC route that must read the body
 * before oidc-provider does. The buffer parser is registered **inside this
 * plugin only** — Fastify's encapsulation keeps it away from
 * `registerOidcRoutes`, whose catch-all must hand oidc-provider an untouched
 * stream. `oidc-boundary.test.ts` asserts that separation directly rather than
 * trusting the registration order to stay right.
 */
export async function registerOidcTokenRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/token',
    {
      // A token request presents a credential, so both rate-limit dimensions,
      // as at every other credential-presenting route.
      config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
      onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
    },
    async (request, reply) => {
      const provider = await oidcProviderFor(request, options);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const params = new URLSearchParams(body.toString('utf8'));

      const credentials = presentedCredentials(request, params);
      if (credentials !== null) {
        // Constant-time, against the stored SHA-256 hash. oidc-provider never
        // sees the real secret.
        const ok = await verifyClientSecret(
          request.tenantId,
          credentials.clientId,
          credentials.secret,
        );
        if (!ok) {
          return reply.status(401).type('application/json').send({
            error: 'invalid_client',
            error_description: 'Client authentication failed',
          });
        }
      }

      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        const refusal = await refuseWithoutDecision(request, provider, params);
        if (refusal) return reply.status(400).type('application/json').send(refusal);
      } else if (grantType === 'client_credentials') {
        const refusal = await guardClientCredentials(request, params);
        if (refusal) {
          const status = refusal.error === 'invalid_client' ? 401 : 400;
          return reply.status(status).type('application/json').send(refusal);
        }
      }

      const forProvider = substitutedRequest(
        request.raw.headers,
        body,
        params,
        credentials,
      );

      reply.hijack();
      // The body was consumed above, so it is replayed. See
      // `requestForProvider`.
      await provider.callback()(
        requestForProvider(request.raw, forProvider.body, forProvider.headers),
        reply.raw,
      );
    },
  );
}
