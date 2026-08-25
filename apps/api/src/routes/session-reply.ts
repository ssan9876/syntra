import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createSession,
  permissionsForUser,
  type AuthorizeResult,
  type SessionAllowance,
  type SessionScope,
} from '@syntra/core';
import { SESSION_COOKIE } from '../plugins/require-session.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Whether this deployment's cookies carry `Secure`, from `PUBLIC_URL`.
     *
     * A decoration rather than an option threaded through four route
     * registrations, because `issueSession` is called from `auth.ts`,
     * `mfa.ts`, `enrol.ts` and `federation.ts` and none of them take options
     * of their own. One value, set once in `buildApp`, read where the cookie
     * is written.
     */
    cookieSecure: boolean;
  }
}

/**
 * How a session cookie is written. One definition, because four routes set the
 * same cookie and a fifth will, and the attribute that matters most —
 * `httpOnly` — is the one nobody notices missing from a copy.
 *
 * `secure` comes from `PUBLIC_URL`'s scheme, not from NODE_ENV. The variable it
 * used to read is one `config.ts` has no say in and the lab deployment sets
 * nowhere, so an instance behind TLS sent session tokens without `Secure` and
 * nothing anywhere reported a misconfiguration. The scheme of the URL the
 * deployment is reached at is the fact this actually wanted, and it is
 * validated at startup.
 *
 * Still false on plain HTTP: a development server would otherwise set a cookie
 * that never comes back, which reads as "sign-in is broken".
 */
export const sessionCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure,
});

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
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(request.server.cookieSecure));
  return {
    status: 'authenticated',
    ...(await sessionBody(request, decision.userId, decision.scope)),
  };
}

/**
 * Sends a browser to the step-up screen, carrying everything that screen needs.
 *
 * The protocol routes cannot answer a decision the way the JSON endpoints do:
 * their caller is a *browser mid-redirect*, not the React application's own
 * fetch, so there is nothing to hand a response body to. The screen therefore
 * has to be told out of band, and the URL is the only channel there is.
 *
 * Three routes built this string by hand and all three sent only the attempt
 * token, which was not enough for the screen to render: `/mfa` and `/enrol`
 * read their pending challenge from `sessionStorage`, nothing had written any,
 * and every SAML, OIDC and upstream-federation step-up therefore dead-ended on
 * "This step expired. Sign in again to continue." — from a redirect Syntra had
 * issued itself, one hop earlier. `factors` and `expires` are what closes that:
 * which factors the chokepoint said it would accept, so the screen offers
 * those and not a recovery code the server would refuse, and when the attempt
 * stops being answerable.
 *
 * The attempt token is a bearer credential and this puts it in a URL, which is
 * a real cost — proxy logs, browser history, `Referer`. It is bounded rather
 * than avoided: the attempt lives minutes, buys exactly one step of one
 * sign-in, and the screen strips it from the address bar before anything else
 * loads. There is no other way to carry it across a full-page redirect the
 * server initiated.
 */
export function challengeRedirect(
  reply: FastifyReply,
  decision: Extract<AuthorizeResult, { status: 'challenge' | 'enrol' }>,
  returnTo: string,
): FastifyReply {
  const path = decision.status === 'challenge' ? '/mfa' : '/enrol';
  const factors =
    decision.status === 'challenge'
      ? decision.acceptableFactors
      : decision.enrollableFactors;
  // Insertion order is preserved, and `attempt` stays first.
  const query = new URLSearchParams({
    attempt: decision.attemptToken,
    factors: factors.join(','),
    expires: decision.expiresAt.toISOString(),
    next: returnTo,
  });
  return reply.redirect(`${path}?${query.toString()}`, 302);
}
