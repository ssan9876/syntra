import { randomBytes } from 'node:crypto';
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
 * Parks a validated AuthnRequest while the user signs in.
 *
 * Everything on the row has already been checked — the ACS URL against the
 * allowlist, the signature against the SP's registered certificates — and the
 * browser carries only `handle`, which is opaque and means nothing anywhere
 * else. The alternative, round-tripping the request through the browser,
 * means re-checking every field on the way back, and the check that gets
 * forgotten is the ACS allowlist.
 */
export async function parkAuthnRequest(
  tenantId: string,
  input: Omit<ParkedAuthnRequest, 'id' | 'handle'> & { ttlMs?: number },
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

export async function findParkedAuthnRequest(
  tenantId: string,
  handle: string,
  now: Date = new Date(),
): Promise<ParkedAuthnRequest | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.samlAuthnRequest.findFirst({
      where: { handle, consumedAt: null, expiresAt: { gt: now } },
    });
    if (!row) return null;
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
