import type { FastifyRequest } from 'fastify';
import {
  resolveSession,
  type ResolvedSession,
  type SessionScope,
} from '@syntra/core';
import { ProblemError } from './problem-json.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: ResolvedSession;
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
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      throw new ProblemError(401, 'unauthenticated', 'Unauthenticated');
    }

    const session = await request.db((tx) => resolveSession(tx, token));
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

    request.session = session;
  };
}
