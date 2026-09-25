import type { FastifyInstance } from 'fastify';
import {
  credentialPickupRevealResponse,
  credentialPickupStatusResponse,
  credentialPickupTokenParam,
} from '@syntra/contracts';
import {
  credentialPickupStatus,
  revealCredentialPickup,
  type MasterKeyProvider,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';

export interface CredentialPickupRouteOptions {
  keyProvider: MasterKeyProvider;
  /** Attempts per minute, per tenant per address. */
  authRateLimitMax: number;
  /** Attempts per minute for the whole tenant, across every address. */
  authRateLimitTenantMax: number;
}

/**
 * The page behind a created account's one-time sign-in link.
 *
 * Unauthenticated by nature: the person holding the link has no account they
 * can sign in with yet -- that is what the link is for. The tenant is the
 * hostname, as for every other route (`plugins/tenant-context.ts`), and the
 * token is the whole of the credential. It is 256 bits, so guessing one is not
 * a real attack, but both routes carry the password endpoints' rate limits
 * anyway: an unauthenticated endpoint that answers as fast as it is asked is
 * a free probe of the database for anyone who finds it.
 *
 * TWO ROUTES, AND THE SPLIT IS THE DESIGN. Mail scanners -- Microsoft Safe
 * Links, and every gateway like it -- fetch each URL in a message before the
 * recipient sees it. A link whose GET revealed the password would be spent by
 * the scanner, and the person would open a page saying "already used". So the
 * GET answers what the page needs to render and changes nothing (not even an
 * audit row), and the password comes only from the POST a person sends by
 * pressing "Show password".
 */
export async function registerCredentialPickupRoutes(
  app: FastifyInstance,
  options: CredentialPickupRouteOptions,
): Promise<void> {
  const LIMIT = {
    config: {
      rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' },
    },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax, 'credential-pickup'),
  };

  app.get('/:token', { ...LIMIT }, async (request, reply) => {
    const { token } = credentialPickupTokenParam.parse(request.params);
    const status = await credentialPickupStatus(request.tenantId, token);
    // Stored nowhere on the way: a cached copy of this page is a cached copy
    // of somebody's username, and a stale "ready" is worse than a fresh read.
    reply.header('cache-control', 'no-store');
    if (status === null) {
      throw new ProblemError(
        404,
        'credential-link-unknown',
        'That link is not recognised',
        'Check that the whole link was copied, or ask your administrator to send a new one.',
      );
    }
    return credentialPickupStatusResponse.parse({
      ...status,
      expiresAt: status.expiresAt.toISOString(),
    });
  });

  app.post('/:token/reveal', { ...LIMIT }, async (request, reply) => {
    const { token } = credentialPickupTokenParam.parse(request.params);
    const outcome = await revealCredentialPickup(request.tenantId, options.keyProvider, token, {
      sourceIp: request.ip,
    });
    // On the refusal too. `no-store` is what keeps a password out of every
    // cache between here and the browser, including the browser's own.
    reply.header('cache-control', 'no-store');
    if (!outcome.ok) {
      // One answer for every refusal. The page read the link's state on the
      // way in; the audit trail has the reason. See `revealCredentialPickup`.
      throw new ProblemError(
        410,
        'credential-link-unusable',
        'That link no longer works',
        'Each link shows the password once and expires after three days. Ask your administrator to send a new one.',
      );
    }
    return credentialPickupRevealResponse.parse({
      username: outcome.username,
      password: outcome.password,
    });
  });
}
