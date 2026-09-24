import type {
  FastifyInstance,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import { ProblemError } from './problem-json.js';

/**
 * The per-address key.
 *
 * Both dimensions, because a bare `request.ip` is one bucket shared by every
 * tenant on the deployment: one tenant's noisy office NAT then locks everyone
 * else out, and a tenant under attack takes the rest down with it. Tenant
 * first so the key reads the way the buckets nest.
 *
 * `/health/ready` is unauthenticated and rate-limited, and reaches this
 * fallback on every request -- the 'unscoped' bucket is shared by everyone
 * hitting it, which is fine for a single low-value endpoint.
 */
export function tenantAndIpKey(request: FastifyRequest): string {
  return `${request.tenantId || 'unscoped'}|${request.ip}`;
}

/** Which perTenantRateLimit scopes each built app has handed out. */
const scopesInUse = new WeakMap<object, Set<string>>();

/**
 * The ceiling on credential attempts for a whole tenant, across every address
 * at once.
 *
 * Spec section 12 asks for per-tenant *and* per-IP limiting, and it means both
 * at once rather than either. A per-IP limit alone is bounded only by how many
 * addresses the attacker has: a wrong second factor deliberately does not
 * consume the attempt — that is what stops a mistyped code costing the user
 * their whole sign-in — and `AuthAttempt` carries no failure counter, so a
 * six-digit TOTP code is around twenty bits, and twenty bits at ten a minute
 * from a thousand addresses is an afternoon. This is the limit that does not
 * move when the attacker rents more addresses.
 *
 * Built on `createRateLimit` rather than `rateLimit` deliberately.
 * `@fastify/rate-limit`'s hook marks the request as limited and every later
 * hook from the same plugin returns without counting, so two of its hooks on
 * one route silently collapse into whichever ran first — the second dimension
 * would look present and do nothing. `createRateLimit` hands back the decision
 * instead of enforcing it, which is what lets this stand beside the per-address
 * limit each route already carries.
 *
 * `scope` names this limiter's counters. The in-memory store gave every call a
 * private LRU, so each call site counted on its own; the shared Postgres store
 * (`rate-limit-store.ts`) has one table, and a `createRateLimit` limiter has
 * no route to namespace it by, so the scope in the key is what keeps those
 * call sites apart — identically on every replica, which a registration-order
 * counter would not promise across a rolling upgrade. A scope used twice in
 * one app is refused at startup: two limiters silently sharing one counter is
 * a ceiling that is half what it says.
 */
export function perTenantRateLimit(
  app: FastifyInstance,
  max: number,
  scope: string,
): onRequestAsyncHookHandler {
  // Keyed on the decorator, which every encapsulated child context inherits
  // from the root by reference, so this is one registry per built app.
  let scopes = scopesInUse.get(app.createRateLimit);
  if (!scopes) {
    scopes = new Set();
    scopesInUse.set(app.createRateLimit, scopes);
  }
  if (scopes.has(scope)) {
    throw new Error(`perTenantRateLimit scope "${scope}" is already in use`);
  }
  scopes.add(scope);

  const limit = app.createRateLimit({
    max,
    timeWindow: '1 minute',
    keyGenerator: (request) => `tenant|${scope}|${request.tenantId || 'unscoped'}`,
  });

  return async (request, reply) => {
    const outcome = await limit(request);
    if (outcome.isAllowed || !outcome.isExceeded) return;

    reply.header('retry-after', outcome.ttlInSeconds);
    throw new ProblemError(
      429,
      'rate-limited',
      'Too many requests',
      `This organization has made too many authentication attempts. Try again in ${outcome.ttlInSeconds} seconds.`,
    );
  };
}
