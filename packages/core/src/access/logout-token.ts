import { createPrivateKey, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { ActiveKey } from '../keys/signing-key-service.js';

/**
 * The event claim OpenID Connect Back-Channel Logout 1.0 defines. A relying
 * party identifies a logout token by this and by nothing else.
 */
export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export interface LogoutTokenInput {
  /** The OP's issuer, exactly as discovery publishes it. */
  issuer: string;
  /** The relying party's `client_id`. */
  audience: string;
  /** The end user the session belonged to. */
  subject: string;
  /** The session that ended, when there is one to name. */
  sessionId: string | null;
  /** Whether this client registered `backchannel_logout_session_required`. */
  includeSid: boolean;
}

/**
 * A logout token, signed with the tenant's active OIDC key.
 *
 * The same key the id tokens are signed with, deliberately: a relying party
 * verifies this against a JWKS it already fetches, and it rotates with
 * everything else. A separate key for one message type would be a second
 * rotation to get wrong, and it would go wrong quietly -- nobody notices a
 * logout that was not delivered.
 *
 * NO `nonce`, ever. Section 2.4 of the specification prohibits it and requires
 * a conforming relying party to REJECT a logout token that carries one. A
 * `nonce` added here out of symmetry with the id token would break delivery
 * against precisely the implementations that read the spec, and work against
 * the ones that did not.
 *
 * The lifetime is short. A logout token is delivered promptly or it is
 * retried; one that arrives two hours later describes a session nobody is
 * holding, and accepting it that late widens the window in which a captured
 * token could be replayed against the relying party.
 */
export async function mintLogoutToken(
  input: LogoutTokenInput,
  key: ActiveKey,
): Promise<string> {
  return new SignJWT({
    events: { [BACKCHANNEL_EVENT]: {} },
    // `sid` only when the client asked for it. A client that did not ask has
    // no session identifier of ours to match it against, so sending one tells
    // it nothing and names one of our sessions in its logs.
    ...(input.includeSid && input.sessionId !== null ? { sid: input.sessionId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'logout+jwt' })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setIssuedAt()
    // Required to be unique, and used by a relying party to discard a
    // duplicate: a retry after a timeout that actually arrived is the ordinary
    // case, not an exceptional one.
    .setJti(randomUUID())
    .setExpirationTime('2m')
    .sign(createPrivateKey(key.privateKeyPem));
}
