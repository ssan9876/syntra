import type { FastifyRequest } from 'fastify';
import { hasPermission, type Permission } from '@syntra/core';
import { ProblemError } from './problem-json.js';

/**
 * Requires a permission. Runs after requireSession('admin'), which is what
 * establishes request.session.
 *
 * Authorization is decided here and only here. The web application hides
 * navigation the caller cannot use, but hiding a link is presentation, not a
 * control — this is the control.
 */
export function requirePermission(permission: Permission) {
  return async function guard(request: FastifyRequest): Promise<void> {
    const allowed = await request.db((tx) =>
      hasPermission(tx, request.session.userId, permission),
    );

    // AN INTERSECTION, NEVER A UNION.
    //
    // A machine token may be narrower than the account it acts as, and can
    // never be wider. Both halves are checked, and both matter:
    //
    // - The account's roles are checked ABOVE, for every caller. That is what
    //   makes revoking a service account's role revoke every token it ever
    //   issued, at once, with no token-by-token cleanup -- which is what makes
    //   offboarding an integration a single act.
    // - The token's own scopes are checked HERE. That is what stops a token
    //   minted for one job from quietly doing everything its account can, so
    //   one over-broad account does not become many over-broad credentials.
    //
    // A union would pass a token naming a permission its account does not
    // hold, and hand it authority nobody ever granted the account. There is a
    // test for exactly that case.
    //
    // An empty scope list means the account's own authority, matching how an
    // empty webhook subscription means every event. The console always writes
    // an explicit list, so the permissive reading is reachable only by an
    // integrator who asked for it.
    const withinScope =
      !request.session.viaToken ||
      request.session.tokenScopes.length === 0 ||
      request.session.tokenScopes.includes(permission);

    if (!allowed || !withinScope) {
      throw new ProblemError(
        403,
        'forbidden',
        'Forbidden',
        `Requires ${permission}`,
      );
    }
  };
}
