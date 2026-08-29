/**
 * The scheme, host and port a tenant publishes its protocol identifiers under.
 *
 * Extracted into core because TWO places need it and they must not disagree.
 * `tenantProtocolIdentity` in the API builds the issuer oidc-provider is
 * constructed with; the back-channel logout sender mints tokens whose `iss` a
 * relying party checks against exactly that value. A second copy of this
 * formula that drifted by a port or a scheme would produce logout tokens every
 * correctly-configured relying party rejects — and rejects silently, because
 * the only symptom is a session that failed to end somewhere else.
 *
 * Never derived from the request. `tenant-context.ts` resolves a tenant from
 * the leftmost label of the Host header, so `acme.attacker.example` resolves
 * tenant `acme` — and an issuer built from that header would let an attacker
 * choose the value a relying party checks against, which is the whole content
 * of the identifier.
 *
 * The scheme and port come from `PUBLIC_URL` because behind a TLS-terminating
 * proxy the server sees `http` unless told to trust forwarded headers, and an
 * issuer that says `http` where the relying party saw `https` fails discovery
 * with a message that points nowhere useful.
 */
export function protocolBase(
  tenant: { primaryDomain: string | null },
  publicUrl: string,
): string {
  const fallback = new URL(publicUrl);
  const host = tenant.primaryDomain ?? fallback.hostname;
  const port = fallback.port ? `:${fallback.port}` : '';
  return `${fallback.protocol}//${host}${port}`;
}

/** The OIDC issuer, which is the base plus the mount. */
export function oidcIssuerFor(
  tenant: { primaryDomain: string | null },
  publicUrl: string,
): string {
  return `${protocolBase(tenant, publicUrl)}/oidc`;
}
