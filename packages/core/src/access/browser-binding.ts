import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Tying a parked, single-use row to the browser that created it.
 *
 * Two flows need this and they are on opposite sides of the same protocol.
 * `SamlAuthnRequest` parks an incoming sign-on request while the user
 * authenticates; `FederationRequest` parks an outgoing one while an upstream
 * identity provider authenticates them. Both hand the browser an opaque
 * identifier — a handle, a `state`, a `RelayState` — and both look the row up
 * by it when the browser comes back.
 *
 * Without a binding that identifier is a bearer credential, and the attack is
 * the same both ways round: whoever can make Syntra park a row can take the
 * identifier out of the 302 they were given and hand it to somebody else. On
 * the identity-provider side that mints an assertion for the victim; on the
 * consuming side the victim is signed in *as the attacker*, because the
 * upstream's answer genuinely is the attacker's and genuinely answers the
 * attacker's own request. Every check on the message passes. `state` is only a
 * CSRF defence when it is bound to the browser that started the flow — stored
 * server-side and looked up, it is a replay defence and nothing more
 * (RFC 6819 section 4.4.1.8).
 *
 * The nonce goes to the browser in a cookie of its own and never anywhere
 * else; only its SHA-256 is written to the database, so a parked row is not a
 * credential even to something that can read the table.
 */

/** A fresh nonce for the cookie, and the digest to store beside the row. */
export function newBrowserBinding(): { nonce: string; digest: string } {
  const nonce = randomBytes(32).toString('base64url');
  return { nonce, digest: browserBindingDigest(nonce) };
}

/** The stored form of a browser-binding nonce. */
export function browserBindingDigest(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

/**
 * Whether the nonce a browser presented is the one a row was parked under.
 *
 * `presented` is the raw cookie value or null, never a digest — a caller that
 * hashed it first would have to remember to, and the one that forgets has
 * written a check that never matches or one that always does. A missing cookie
 * is null and never matches.
 *
 * Constant-time. Both operands are public-length hex strings so the length
 * check leaks nothing, and `timingSafeEqual` throws on a length mismatch
 * rather than returning false, which is why the length is compared first.
 */
export function browserBindingMatches(
  presented: string | null | undefined,
  storedDigest: string,
): boolean {
  if (presented === null || presented === undefined || presented === '') return false;
  const digest = browserBindingDigest(presented);
  if (digest.length !== storedDigest.length) return false;
  return timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(storedDigest, 'utf8'));
}
