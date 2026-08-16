import type { FastifyInstance } from 'fastify';
import { compactVerify, createLocalJWKSet } from 'jose';
import {
  findOidcClient,
  isRegisteredPostLogoutUri,
  publishedKeys,
  recordEvent,
  resolveSession,
  revokeSession,
} from '@syntra/core';
import { isProtocolEndpoint } from '@syntra/contracts';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import { assertProtocolHost, tenantProtocolIdentity } from './protocol-identity.js';
import { oidcProviderFor, requestForProvider, type OidcRouteOptions } from './oidc-op.js';

/**
 * The subject an `id_token_hint` names, or null if it is not one of ours.
 *
 * Signature-only, deliberately: `compactVerify` rather than `jwtVerify`. The
 * hint's job is to say WHOSE session is being ended, and an id_token is a
 * one-hour credential — checking `exp` would refuse a logout from anybody who
 * signed in this morning, which is most logouts. The issuer is checked,
 * because a signature from this tenant's key on a token minted for something
 * else is not evidence about this tenant's session.
 *
 * No network: `publishedKeys` is a database read and the verification is local
 * arithmetic, both outside any transaction.
 */
async function subjectOfHint(
  tenantId: string,
  issuer: string,
  hint: string,
): Promise<string | null> {
  try {
    const keys = await publishedKeys(tenantId, 'oidc');
    if (keys.length === 0) return null;
    const jwks = createLocalJWKSet({ keys: keys.map((k) => k.publicJwk) as never });
    const { payload } = await compactVerify(hint, jwks);
    const claims = JSON.parse(Buffer.from(payload).toString('utf8')) as {
      iss?: unknown;
      sub?: unknown;
    };
    if (claims.iss !== issuer) return null;
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    // A malformed, unsigned or foreign token names nobody.
    return null;
  }
}

/**
 * RP-initiated logout.
 *
 * Registered ahead of the catch-all so Syntra's own session is ended before
 * `oidc-provider` handles the OIDC half. Ending only oidc-provider's session
 * would leave the Syntra cookie live: the user would appear signed out of the
 * application and be signed straight back in on the next launch, which is the
 * opposite of what "log me out" means and is the sort of thing a customer
 * finds rather than a test.
 *
 * Three things make the destructive part safe to reach over a plain GET.
 *
 * 1. **The host is checked first.** `assertProtocolHost` used to run inside
 *    `oidcProviderFor`, at the END of the handler — so the session was
 *    revoked and the cookie cleared, and only then was the request refused for
 *    having arrived on the wrong host.
 * 2. **`id_token_hint` is required, and it has to name the session being
 *    ended.** Without it this is a logout CSRF: any cross-site link or image
 *    signs the user out, and `logoutSource` auto-submits with no confirmation
 *    so there is no interstitial to stop it. Requiring the hint is not enough
 *    on its own — an attacker with an account in this tenant holds an
 *    id_token of their own — so its subject is compared against the session
 *    the cookie resolves to, and a mismatch revokes nothing.
 * 3. **It is rate limited**, on both dimensions, like every other protocol
 *    route. This was the one route without the `rateLimited` options object.
 *
 * The post-logout redirect URI is matched exactly against the client's
 * registered list. `oidc-provider` performs the same check, and it is
 * performed here too because this handler answers first and could otherwise
 * become an open redirect on its own.
 */
export async function registerOidcLogoutRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  const rateLimited = {
    config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };

  app.get('/session/end', rateLimited, async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    // BEFORE anything is revoked. See the doc comment above.
    assertProtocolHost(request, identity);

    const query = request.query as Record<string, string | undefined>;
    const target = query.post_logout_redirect_uri;

    if (target !== undefined) {
      if (!isProtocolEndpoint(target)) {
        throw new ProblemError(400, 'oidc-bad-redirect', 'Unusable post-logout redirect URI');
      }
      const clientId = query.client_id;
      const client = clientId ? await findOidcClient(request.tenantId, clientId) : null;
      // No client id and no id_token_hint means nothing identifies which
      // allowlist to check, so there is no allowlist this can be on.
      if (!client || !isRegisteredPostLogoutUri(client, target)) {
        throw new ProblemError(
          400, 'oidc-bad-redirect',
          'That post-logout redirect URI is not registered for this client',
        );
      }
    }

    const hint = query.id_token_hint;
    if (typeof hint !== 'string' || hint === '') {
      throw new ProblemError(
        400,
        'oidc-logout-needs-hint',
        'This logout needs an id_token_hint',
        'Ending a session is destructive and this endpoint is reachable by a plain cross-site GET, so it will not act without an id_token this identity provider issued for the session being ended.',
      );
    }

    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await request.db((tx) => resolveSession(tx, token)) : null;
    const subject = await subjectOfHint(request.tenantId, identity.issuer, hint);

    if (session && subject !== session.userId) {
      // Somebody else's id_token, or none of ours. Refused rather than
      // ignored: carrying on would leave the browser at a "you are signed
      // out" screen with the session still live.
      throw new ProblemError(
        400,
        'oidc-logout-hint-mismatch',
        'That id_token_hint does not name this session',
      );
    }

    if (token && session) {
      await request.db(async (tx) => {
        await revokeSession(tx, token);
        await recordEvent(tx, {
          actorUserId: session.userId,
          action: 'oidc.logout',
          targetType: 'User',
          targetId: session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { clientId: query.client_id ?? null },
        });
      });
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    }

    // Hand the rest to oidc-provider, which ends its own session and performs
    // the redirect with the state parameter the client sent.
    //
    // `requestForProvider` is not optional here: oidc-provider's router
    // matches routes against `ctx.path` with no mount prefix
    // (`lib/helpers/initialize_app.js`), so handing it the raw request
    // unchanged — still carrying `/oidc/session/end` — returns a bare Koa 404
    // for every call, exactly as it would for `/token` or the catch-all. See
    // `requestForProvider`'s own doc comment.
    const provider = await oidcProviderFor(request, options);
    reply.hijack();
    await provider.callback()(requestForProvider(request.raw, null), reply.raw);
  });
}
