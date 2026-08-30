import type { FastifyRequest } from 'fastify';
import { API_TOKEN_PREFIX, authorize, resolveApiToken, touchApiToken } from '@syntra/core';
import type { RequestPrincipal } from './require-session.js';

/**
 * The route patterns a machine token is refused at, whatever it holds.
 *
 * A prefix list rather than a check inside each route, so adding a route to a
 * guarded family does not mean remembering this file — and an entry here is a
 * decision somebody reads rather than an absence somebody has to notice.
 *
 * Each one is refused for a different reason:
 *
 * - `/api/auth` — signing in, elevating, changing a password. A token is
 *   already authenticated, so there is nothing here for it to do, and a token
 *   that could elevate would be a token that could mint a session. That is a
 *   credential upgrade, and the whole point of a bearer token is that it does
 *   not get one.
 * - `/api/portal` — a machine has no applications to launch, and no person
 *   whose access the portal would be showing.
 * - The password routes — handing a program the ability to set a HUMAN's
 *   credential is a different authority from managing the directory, and it is
 *   not one this slice grants. `directory.write` gets you a display name, not
 *   somebody's password.
 * - The TOKEN routes — a credential that can mint credentials is a credential
 *   whose revocation does not end its authority. A stolen token holding
 *   `token.manage` would issue a second token, and revoking the first would
 *   leave the second working with nobody having any reason to look for it.
 *   Minting a machine credential is a thing a person does.
 */
export const TOKEN_DENIED_ROUTES: readonly string[] = [
  '/api/auth',
  '/api/portal',
  '/api/admin/users/:id/password',
  '/api/admin/users/:id/password-setup',
  '/api/admin/users/:id/tokens',
];

export function routeRefusesTokens(routePattern: string | undefined): boolean {
  if (routePattern === undefined) return false;
  return TOKEN_DENIED_ROUTES.some((denied) => routePattern.startsWith(denied));
}

/** The value after `Bearer `, when it looks like one of ours. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const value = header.slice('Bearer '.length).trim();
  // Only a token this product issued. An OAuth access token presented here by
  // mistake is not something to hash and look up.
  return value.startsWith(API_TOKEN_PREFIX) ? value : null;
}

/**
 * Turns a presented token into a principal, through `authorize()`.
 *
 * Never resolves the token and trusts it. `authorize({ kind: 'token' })` is
 * what applies account status and policy, and going around it here would be
 * building the exemption the design document argues against — one function
 * call later, and much harder to notice.
 *
 * Returns null for every refusal, in one shape. The audit log inside
 * `authorize` records which refusal it was.
 */
export async function resolveBearerPrincipal(
  request: FastifyRequest,
): Promise<RequestPrincipal | null> {
  const token = bearerToken(request);
  if (token === null) return null;

  const decision = await authorize(request.tenantId, {
    kind: 'token',
    token,
    sourceIp: request.ip,
  });

  if (decision.status !== 'allow') return null;

  // Read again for the id and scopes. `authorize` deliberately answers with a
  // decision and not with the credential behind it -- widening its result to
  // carry token fields would put an API concern in the chokepoint's contract.
  const resolved = await request.db((tx) => resolveApiToken(tx, token));
  if (resolved === null) return null;

  // AFTER the decision, never before: a token that was refused has not been
  // used, and recording it as used would make a rejected credential look
  // active on the screen an operator uses to find dormant ones.
  await request.db((tx) => touchApiToken(tx, resolved.id));

  return {
    sessionId: resolved.id,
    userId: decision.userId,
    scope: 'admin',
    satisfiedFactor: null,
    createdAt: new Date(),
    viaToken: true,
    tokenScopes: resolved.scopes,
  };
}
