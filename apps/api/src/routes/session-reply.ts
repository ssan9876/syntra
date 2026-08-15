import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createSession,
  permissionsForUser,
  type SessionAllowance,
  type SessionScope,
} from '@syntra/core';
import { SESSION_COOKIE } from '../plugins/require-session.js';

/**
 * How a session cookie is written. One definition, because four routes set the
 * same cookie and a fifth will, and the attribute that matters most —
 * `httpOnly` — is the one nobody notices missing from a copy.
 *
 * `secure` follows NODE_ENV rather than being hard-wired: a development server
 * runs on plain HTTP and a cookie marked secure would simply never come back,
 * which reads as "sign-in is broken" rather than as a misconfiguration.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: process.env.NODE_ENV === 'production',
};

export interface SessionBody {
  userId: string;
  displayName: string;
  scope: SessionScope;
  mayElevate: boolean;
  permissions: string[];
}

/**
 * What the web client needs to render a signed-in person: who they are, what
 * kind of session they hold, and what the console would let them do.
 *
 * `mayElevate` is deliberately "holds any permission at all" rather than a
 * permission of its own — it decides whether the header offers the console,
 * and the console's own routes each check the permission they need.
 */
export async function sessionBody(
  request: FastifyRequest,
  userId: string,
  scope: SessionScope,
): Promise<SessionBody> {
  const { user, permissions } = await request.db(async (tx) => ({
    user: await tx.user.findUnique({ where: { id: userId } }),
    permissions: await permissionsForUser(tx, userId),
  }));

  return {
    userId,
    displayName: user?.displayName ?? '',
    scope,
    mayElevate: permissions.size > 0,
    permissions: [...permissions],
  };
}

/**
 * Mints the session for a decision, sets the cookie, and answers with the body
 * every signed-in response shares.
 *
 * The single place a session cookie is written. Four routes reached this point
 * by four slightly different roads — one of them passing the ambient
 * `request.session.userId` where its decision carried the authoritative one —
 * and the differences were all accidents. Everything here comes off the
 * decision: a caller that has not been past `authorize()` cannot produce one,
 * which is what makes "issue a session" and "have a decision" the same act.
 */
export async function issueSession(
  request: FastifyRequest,
  reply: FastifyReply,
  decision: SessionAllowance,
): Promise<{ status: 'authenticated' } & SessionBody> {
  const { token } = await request.db((tx) => createSession(tx, decision));
  reply.setCookie(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
  return {
    status: 'authenticated',
    ...(await sessionBody(request, decision.userId, decision.scope)),
  };
}
