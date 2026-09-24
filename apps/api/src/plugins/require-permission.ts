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
/**
 * Which permissions each guard enforces.
 *
 * Read by the OpenAPI route catalog (`openapi/route-catalog.ts`), which walks
 * every registered route's `preHandler` list and asks this map what each guard
 * demands. That is what puts `x-syntra-permission` in the published document
 * WITHOUT a second, hand-written copy of it: the permission a client is told
 * an operation needs is, by construction, the permission the running server
 * checks. A hand-maintained table would be right on the day it was written and
 * wrong the first time somebody changed a guard and not the table.
 *
 * A WeakMap rather than a property on the function, so the guard stays a plain
 * function Fastify's types accept.
 */
const guardPermissions = new WeakMap<object, readonly Permission[]>();

/** The permissions a guard enforces; empty for a function that is not one. */
export function permissionsOfGuard(fn: unknown): readonly Permission[] {
  return typeof fn === 'function' ? (guardPermissions.get(fn) ?? []) : [];
}

/**
 * Records what a guard that is NOT built by `requirePermission` enforces.
 *
 * For the few bespoke guards — Govern's org-unit-scoped read is the one that
 * exists — so their routes are described with the permission they check
 * rather than with none. The declaration sits beside the check it describes,
 * which is the closest this can get to being the check.
 */
export function declareGuardPermissions<T extends object>(
  guard: T,
  ...permissions: Permission[]
): T {
  guardPermissions.set(guard, permissions);
  return guard;
}

export function requirePermission(permission: Permission) {
  const guard = async function guard(request: FastifyRequest): Promise<void> {
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
  return declareGuardPermissions(guard, permission);
}
