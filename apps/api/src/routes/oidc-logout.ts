import type { FastifyInstance } from 'fastify';
import {
  findOidcClient,
  isRegisteredPostLogoutUri,
  recordEvent,
  resolveSession,
  revokeSession,
} from '@syntra/core';
import { isProtocolEndpoint } from '@syntra/contracts';
import { ProblemError } from '../plugins/problem-json.js';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import { oidcProviderFor, requestForProvider, type OidcRouteOptions } from './oidc-op.js';

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
 * The post-logout redirect URI is matched exactly against the client's
 * registered list. `oidc-provider` performs the same check, and it is
 * performed here too because this handler answers first and could otherwise
 * become an open redirect on its own.
 */
export async function registerOidcLogoutRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  app.get('/session/end', async (request, reply) => {
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

    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const session = await request.db((tx) => resolveSession(tx, token));
      await request.db(async (tx) => {
        await revokeSession(tx, token);
        if (session) {
          await recordEvent(tx, {
            actorUserId: session.userId,
            action: 'oidc.logout',
            targetType: 'User',
            targetId: session.userId,
            outcome: 'success',
            sourceIp: request.ip,
            payload: { clientId: query.client_id ?? null },
          });
        }
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
