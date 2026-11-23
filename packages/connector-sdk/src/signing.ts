import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Request signing: HMAC-SHA256 over the timestamp, a nonce, the method and a
 * hash of the body, keyed with the shared secret stored on the target.
 *
 * Chosen over a bearer token because the secret never travels. A bearer token
 * read from one request (a TLS-terminating proxy's log, a debugging dump) is
 * the credential itself and works from anywhere until it is rotated. A
 * signature works for one body, one method and five minutes, and the nonce
 * makes it work once.
 *
 * The method name is signed rather than the URL path, so a reverse proxy that
 * rewrites the path prefix in front of the service does not break
 * verification.
 */

export const SIGNATURE_SCHEME = 'v1';

/** How far a request's timestamp may be from the service's clock. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A shared secret shorter than this is refused by both ends. */
export const MIN_SECRET_LENGTH = 32;

export function sha256Hex(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The exact bytes that are signed. */
export function signingInput(parts: {
  timestamp: string;
  nonce: string;
  method: string;
  body: string | Uint8Array;
}): string {
  return [SIGNATURE_SCHEME, parts.timestamp, parts.nonce, parts.method, sha256Hex(parts.body)].join('\n');
}

function hmac(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

export interface SignedHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

export function signRequest(
  secret: string,
  method: string,
  body: string,
  options: { now?: number; nonce?: string } = {},
): SignedHeaders {
  const timestamp = String(Math.floor((options.now ?? Date.now()) / 1000));
  const nonce = options.nonce ?? randomUUID();
  const signature = `${SIGNATURE_SCHEME}=${hmac(secret, signingInput({ timestamp, nonce, method, body }))}`;
  return { timestamp, nonce, signature };
}

/**
 * Remembers nonces for as long as their timestamp is acceptable, so a captured
 * request cannot be sent again inside the window.
 *
 * In memory, so it protects one process. A service run as several replicas
 * behind a load balancer passes its own `NonceStore` backed by something they
 * share; without one a replay can reach another replica inside the window.
 * Every write is idempotent by `actionId`, so such a replay repeats a write
 * that already happened; it cannot make a new one.
 */
export interface NonceStore {
  /** Records the nonce. False when it was already recorded and has not expired. */
  claim(nonce: string, expiresAtMs: number): boolean | Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries = 100_000,
    private readonly now: () => number = Date.now,
  ) {}

  claim(nonce: string, expiresAtMs: number): boolean {
    const now = this.now();
    const existing = this.seen.get(nonce);
    if (existing !== undefined && existing > now) return false;
    if (this.seen.size >= this.maxEntries) this.prune(now);
    this.seen.set(nonce, expiresAtMs);
    return true;
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(nonce);
    }
    // Still full: drop the oldest. Map iteration is insertion order.
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

export type VerifyResult = { ok: true } | { ok: false; message: string };

export interface VerifyInput {
  /** The current secret first; during a rotation, the previous one too. */
  secrets: readonly string[];
  method: string;
  body: string | Uint8Array;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  nonces: NonceStore;
  toleranceSeconds?: number;
  now?: number;
}

/**
 * Checks a request's signature. Every message names what was wrong and none
 * says anything about the secret.
 */
export async function verifyRequest(input: VerifyInput): Promise<VerifyResult> {
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.now ?? Date.now();
  if (!input.timestamp || !input.nonce || !input.signature) {
    return { ok: false, message: 'Request is not signed.' };
  }
  if (!/^\d{1,12}$/.test(input.timestamp)) {
    return { ok: false, message: 'Request timestamp is not a number of seconds.' };
  }
  if (input.nonce.length < 16 || input.nonce.length > 128) {
    return { ok: false, message: 'Request nonce must be 16 to 128 characters.' };
  }
  const skew = Math.abs(now / 1000 - Number(input.timestamp));
  if (skew > tolerance) {
    return {
      ok: false,
      message: `Request timestamp is ${Math.round(skew)} s from this service's clock (limit ${tolerance} s). Check both clocks.`,
    };
  }

  const offered = input.signature
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNATURE_SCHEME}=`))
    .map((part) => part.slice(SIGNATURE_SCHEME.length + 1));
  if (offered.length === 0) {
    return { ok: false, message: `Request has no ${SIGNATURE_SCHEME} signature.` };
  }

  const signed = signingInput({
    timestamp: input.timestamp,
    nonce: input.nonce,
    method: input.method,
    body: input.body,
  });
  const matches = input.secrets.some((secret) => {
    const expected = Buffer.from(hmac(secret, signed), 'hex');
    return offered.some((candidate) => {
      if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
      return timingSafeEqual(expected, Buffer.from(candidate, 'hex'));
    });
  });
  if (!matches) return { ok: false, message: 'Request signature does not match.' };

  // Claimed only after the signature checks out, so an unsigned flood cannot
  // fill the store.
  const expiresAt = (Number(input.timestamp) + tolerance) * 1000;
  if (!(await input.nonces.claim(input.nonce, expiresAt))) {
    return { ok: false, message: 'Request nonce was already used.' };
  }
  return { ok: true };
}
