/**
 * The WebAuthn relying party for one request: the host a credential is bound
 * to, and the exact origin the browser will report.
 *
 * Both are per request, because Syntra picks a tenant from the Host header and
 * a credential enrolled at one tenant's hostname must not assert at another's.
 * They travel as an explicit field on AuthorizeRequest rather than in an
 * ambient store: sourceIp is just as request-derived and is already a field,
 * and making this one implicit would mean a background job could compile and
 * then fail at run time inside the one chokepoint every authentication path
 * funnels through.
 */
export interface RelyingParty {
  /** The RP ID: the registrable host, no scheme and no port. */
  id: string;
  /** The exact origin, scheme and port included. */
  origin: string;
}

/** Registration also needs a human-readable name; verification does not. */
export interface RelyingPartyIdentity extends RelyingParty {
  name: string;
}
