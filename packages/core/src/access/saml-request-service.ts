import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withTenant } from '@syntra/db';

export interface ParkedAuthnRequest {
  id: string;
  applicationId: string;
  handle: string;
  requestId: string | null;
  acsUrl: string;
  relayState: string | null;
  forceAuthn: boolean;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * A fresh browser-binding nonce, and the digest that is stored beside the
 * parked row.
 *
 * The nonce goes to the browser in a cookie of its own and never anywhere
 * else; only its SHA-256 is written to the database. A parked row is therefore
 * not a credential even to something that can read the table, which matters
 * because the row also carries `handle` in the clear and the pair would
 * otherwise be everything needed to complete somebody else's sign-in.
 *
 * 32 bytes, the same width as `handle` and as a session token. This value is
 * the whole of the CSRF defence on `/saml/continue`, so it is guessing-proof
 * or it is nothing.
 */
export function newBrowserBinding(): { nonce: string; digest: string } {
  const nonce = randomBytes(32).toString('base64url');
  return { nonce, digest: browserBindingDigest(nonce) };
}

/** The stored form of a browser-binding nonce. */
export function browserBindingDigest(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Both operands are public-length hex strings so the length check leaks
 * nothing, and `timingSafeEqual` throws on a length mismatch rather than
 * returning false, which is why the length is compared first.
 */
function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Parks a validated AuthnRequest while the user signs in.
 *
 * Everything on the row has already been checked — the ACS URL against the
 * allowlist, the signature against the SP's registered certificates — and the
 * browser carries only `handle`, which is opaque and means nothing anywhere
 * else. The alternative, round-tripping the request through the browser,
 * means re-checking every field on the way back, and the check that gets
 * forgotten is the ACS allowlist.
 *
 * `browserBinding` is the digest from `newBrowserBinding()`, and it is a
 * required argument rather than an option: a parked row with no binding is a
 * bearer handle anyone who can read a 302 can spend against a logged-in
 * victim, and a caller that forgets it must not compile.
 */
export async function parkAuthnRequest(
  tenantId: string,
  input: Omit<ParkedAuthnRequest, 'id' | 'handle'> & {
    browserBinding: string;
    ttlMs?: number;
  },
): Promise<ParkedAuthnRequest> {
  const handle = randomBytes(32).toString('base64url');
  const row = await withTenant(tenantId, (tx) =>
    tx.samlAuthnRequest.create({
      data: {
        tenantId,
        applicationId: input.applicationId,
        handle,
        requestId: input.requestId,
        acsUrl: input.acsUrl,
        relayState: input.relayState,
        forceAuthn: input.forceAuthn,
        browserBinding: input.browserBinding,
        expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)),
      },
    }),
  );
  return {
    id: row.id,
    applicationId: row.applicationId,
    handle: row.handle,
    requestId: row.requestId,
    acsUrl: row.acsUrl,
    relayState: row.relayState,
    forceAuthn: row.forceAuthn,
  };
}

/**
 * The parked request a handle names, if the browser presenting it is the one
 * that parked it.
 *
 * `presentedBinding` is the nonce out of the browser's cookie, not a digest,
 * and it is a required argument for the same reason the write side's is: the
 * check is the point of the row's existence and there is no caller for whom
 * skipping it is correct. A missing cookie is `null` and never matches.
 *
 * A wrong binding reads exactly like an expired handle — null — so the two are
 * not distinguishable from outside, and neither confirms that a handle exists.
 */
export async function findParkedAuthnRequest(
  tenantId: string,
  handle: string,
  presentedBinding: string | null,
  now: Date = new Date(),
): Promise<ParkedAuthnRequest | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.samlAuthnRequest.findFirst({
      where: { handle, consumedAt: null, expiresAt: { gt: now } },
    });
    if (!row) return null;
    if (
      presentedBinding === null ||
      !digestsMatch(browserBindingDigest(presentedBinding), row.browserBinding)
    ) {
      return null;
    }
    return {
      id: row.id,
      applicationId: row.applicationId,
      handle: row.handle,
      requestId: row.requestId,
      acsUrl: row.acsUrl,
      relayState: row.relayState,
      forceAuthn: row.forceAuthn,
    };
  });
}

/**
 * Spends the request. Returns false if someone else already did.
 *
 * `updateMany` with `consumedAt: null` in the predicate, so two concurrent
 * completions cannot both issue an assertion for one request. The count is
 * the answer, not a re-read.
 */
export async function consumeParkedAuthnRequest(
  tenantId: string,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.samlAuthnRequest.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: now },
    });
    return result.count === 1;
  });
}
