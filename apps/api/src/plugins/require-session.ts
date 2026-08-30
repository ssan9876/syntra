import type { FastifyRequest } from 'fastify';
import {
  resolveSession,
  type ResolvedSession,
  type SessionScope,
} from '@syntra/core';
import { ProblemError } from './problem-json.js';
import { resolveBearerPrincipal, routeRefusesTokens } from './bearer-token.js';

/**
 * Who a request is, however they proved it.
 *
 * Extends core's `ResolvedSession` here rather than widening it there: a token
 * is an API concern, and putting `viaToken` on the core type would have every
 * consumer of a session carrying a field about a credential format it has no
 * opinion on.
 */
export interface RequestPrincipal extends ResolvedSession {
  /** Established by a bearer token rather than a session cookie. */
  viaToken: boolean;
  /**
   * The token's own scopes, INTERSECTED with the account's roles by
   * `requirePermission`. Empty means the account's full authority. Always
   * empty for a cookie session, which has no second bound.
   */
  tokenScopes: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    session: RequestPrincipal;
  }
}

export const SESSION_COOKIE = 'syntra_session';

/**
 * Requires a live session of at least the given scope.
 *
 * An admin route asks for 'admin', and a portal session presenting itself
 * there is rejected. This is the server-side half of running one web
 * application for two audiences: the React router hides the console, but this
 * is what actually keeps a portal user out of it.
 */
export function requireSession(required: SessionScope) {
  return async function guard(request: FastifyRequest): Promise<void> {
    const cookie = request.cookies[SESSION_COOKIE];

    // A bearer token is tried only when there is no cookie. A browser that
    // holds both is a browser, and letting a header override its session would
    // be a way to act as somebody else from inside their own tab.
    if (!cookie) {
      const principal = await resolveBearerPrincipal(request);
      if (principal !== null) {
        if (routeRefusesTokens(request.routeOptions?.url)) {
          // 403, not 401. The credential was perfectly good; this route is not
          // one a machine may use, and answering 401 would send an integrator
          // to check a token that is fine.
          throw new ProblemError(
            403,
            'token-not-accepted',
            'This route does not accept an API token',
            'Sign in as a person. Tokens cannot reach authentication, the portal, or another account’s password.',
          );
        }
        request.session = principal;
        return;
      }
    }

    if (!cookie) {
      throw new ProblemError(401, 'unauthenticated', 'Unauthenticated');
    }

    const session = await request.db((tx) => resolveSession(tx, cookie));
    if (!session) {
      throw new ProblemError(401, 'unauthenticated', 'Unauthenticated');
    }

    if (required === 'admin' && session.scope !== 'admin') {
      throw new ProblemError(
        403,
        'admin-session-required',
        'Administrative session required',
        'Re-authenticate at /api/auth/elevate to obtain an administrative session.',
      );
    }

    request.session = { ...session, viaToken: false, tokenScopes: [] };
  };
}
