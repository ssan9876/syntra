import type { KeyKind } from './signing-key-service.js';

export type SigningKeysChangedListener = (tenantId: string, kind: KeyKind) => void;

const listeners = new Set<SigningKeysChangedListener>();

/**
 * Called when a tenant's published key set changes — a rotation, or an
 * outgoing key reaching the end of its overlap.
 *
 * This exists because the OIDC `Provider` resolves its JWKS **once**, at
 * construction, and is then cached per tenant. Rotation writes the new key,
 * the JWKS route serves it (it reads `publishedKeys` fresh per request, which
 * is why the existing rotation test cannot see any of this), and the cached
 * provider carries on signing with the *old* private key. That is harmless for
 * the length of the overlap and becomes a total outage the moment the old key
 * is retired and stops being published — every token the tenant issues fails
 * validation, until somebody restarts the process.
 *
 * A listener rather than a call from `rotateKey` to `invalidateProvider`
 * because `@syntra/core` may not import `@syntra/protocols` (spec section 5's
 * package boundary, and the dependency runs the other way). It is also the
 * shape that does not depend on the caller remembering: whoever calls
 * `rotateKey` — a job, an admin route, a test, whatever gets written next —
 * gets the invalidation, rather than the second caller being the one that
 * ships the outage.
 *
 * Registered once at startup by `apps/api`. Returns an unregister function so
 * a test can put the registry back.
 */
export function onSigningKeysChanged(listener: SigningKeysChangedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Announces a change. Listener failures are swallowed on purpose.
 *
 * By the time this runs the rotation has committed. Letting a listener's throw
 * escape would report a rotation that happened as a failure, and pg-boss would
 * retry it — rotating again, and again. A listener here evicts a cache entry
 * and must not be able to fail; the comment is the contract.
 */
export function notifySigningKeysChanged(tenantId: string, kind: KeyKind): void {
  for (const listener of listeners) {
    try {
      listener(tenantId, kind);
    } catch {
      // Deliberately ignored. See above.
    }
  }
}
