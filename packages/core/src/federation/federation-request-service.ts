import { randomBytes } from 'node:crypto';
import { withTenant } from '@syntra/db';
import { browserBindingMatches } from '../access/browser-binding.js';
import { deleteSecret, getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

export interface FederationTicket {
  id: string;
  state: string;
  /**
   * The value the upstream's answer must echo back: the id_token's `nonce`
   * claim for OIDC, the AuthnRequest ID the assertion's signed `InResponseTo`
   * is checked against for SAML. Two protocol meanings, one purpose.
   */
  expectedResponseTo: string | null;
  /** Vault secret name holding the PKCE verifier, or null. Never the value. */
  verifierName: string | null;
  upstreamIdpId: string;
  returnTo: string;
  applicationId: string | null;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Opens one in-flight upstream login.
 *
 * The PKCE verifier goes into the vault rather than a column: it is a
 * short-lived secret whose disclosure lets anyone holding a stolen
 * authorization code complete the exchange, and the vault is where this
 * codebase puts secrets. The row holds its name.
 *
 * `returnTo` is stored, not carried through the browser, and the route that
 * calls this refuses to store anything but a same-origin path — an open
 * redirect through a federation callback is the classic one.
 *
 * The `state` is 32 bytes from the CSPRNG. It is what the callback is looked
 * up by, so guessing it is guessing an in-flight login.
 *
 * `browserBinding` is the digest from `newBrowserBinding()`, and it is a
 * required argument rather than an option — the same shape `parkAuthnRequest`
 * uses on the identity-provider side, and for the same reason. A row with no
 * binding identifies an in-flight login and no particular browser, which makes
 * the callback URL a bearer credential an attacker can hand to a victim, and a
 * caller that forgets it must not compile.
 */
export async function openFederationRequest(
  tenantId: string,
  input: {
    upstreamIdpId: string;
    returnTo: string;
    applicationId: string | null;
    browserBinding: string;
    expectedResponseTo?: string | undefined;
    verifier?: string | undefined;
    provider?: MasterKeyProvider | undefined;
    ttlMs?: number | undefined;
  },
): Promise<FederationTicket> {
  const state = randomBytes(32).toString('base64url');
  const storeVerifier = input.verifier !== undefined && input.provider !== undefined;
  const verifierName = storeVerifier ? `federation:${state}:verifier` : null;

  return withTenant(tenantId, async (tx) => {
    if (storeVerifier) {
      // AES-GCM wrapping only — microseconds, so it belongs in the same
      // transaction as the row that names it. A row naming a secret that was
      // never written is a login that can never complete its exchange.
      await putSecret(tx, input.provider!, verifierName!, input.verifier!);
    }
    const row = await tx.federationRequest.create({
      data: {
        tenantId,
        upstreamIdpId: input.upstreamIdpId,
        state,
        expectedResponseTo: input.expectedResponseTo ?? null,
        browserBinding: input.browserBinding,
        verifierName,
        returnTo: input.returnTo,
        applicationId: input.applicationId,
        expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)),
      },
    });
    return {
      id: row.id,
      state: row.state,
      expectedResponseTo: row.expectedResponseTo,
      verifierName: row.verifierName,
      upstreamIdpId: row.upstreamIdpId,
      returnTo: row.returnTo,
      applicationId: row.applicationId,
    };
  });
}

/**
 * Spends the in-flight request and returns it, or null.
 *
 * Single-use, decided by the `updateMany` count rather than by a read followed
 * by a write. Two callbacks arriving with the same state — a user
 * double-clicking, or an attacker replaying a captured redirect — produce one
 * winner and one null. This is the replay defence; matching `state` alone is
 * only a CSRF defence, and an authorization code that has already been
 * exchanged once is exactly what a captured redirect carries.
 *
 * The verifier is read and then deleted in the same transaction that consumes
 * the row. It is worth nothing after this call, and a vault that accumulates
 * one dead secret per sign-in is a vault nobody can audit.
 *
 * `presentedBinding` is the nonce out of the browser's cookie, not a digest,
 * and it is a required argument for the same reason the write side's is: the
 * check is most of the point of the row's existence and there is no caller for
 * whom skipping it is correct. A missing cookie is `null` and never matches,
 * and a wrong binding reads exactly like an expired ticket — null — so neither
 * confirms from outside that a login is in flight.
 *
 * Checked BEFORE the row is spent. A mismatched callback must not consume
 * somebody else's live sign-in: that would turn a failed attack into a denial
 * of service against the person whose login it was.
 */
export async function takeFederationRequest(
  tenantId: string,
  state: string,
  presentedBinding: string | null,
  provider: MasterKeyProvider,
  now: Date = new Date(),
): Promise<(FederationTicket & { verifier: string | null }) | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.federationRequest.findFirst({
      where: { state, consumedAt: null, expiresAt: { gt: now } },
    });
    if (!row) return null;
    if (!browserBindingMatches(presentedBinding, row.browserBinding)) return null;

    const claimed = await tx.federationRequest.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return null;

    let verifier: string | null = null;
    if (row.verifierName) {
      verifier = await getSecret(tx, provider, row.verifierName);
      await deleteSecret(tx, row.verifierName);
    }

    return {
      id: row.id,
      state: row.state,
      expectedResponseTo: row.expectedResponseTo,
      verifierName: row.verifierName,
      upstreamIdpId: row.upstreamIdpId,
      returnTo: row.returnTo,
      applicationId: row.applicationId,
      verifier,
    };
  });
}
