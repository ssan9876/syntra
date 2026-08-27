import type { FastifyRequest } from 'fastify';
import { ProblemError } from '../plugins/problem-json.js';

/**
 * Every protocol identifier this tenant publishes.
 *
 * All of them are derived from the tenant's own configuration and from
 * `PUBLIC_URL`. None of them is derived from the request, and this function
 * takes no request, so the wrong thing does not compile.
 *
 * `tenant-context.ts` resolves a tenant from the leftmost label of the Host
 * header, so `acme.attacker.example` resolves tenant `acme`. An issuer, an
 * entity ID, an audience or a Destination built from that header would let an
 * attacker choose the value a relying party checks against — which is the
 * whole content of the identifier. `relying-party.ts` made the same decision
 * for WebAuthn; this is that decision applied to every remaining protocol
 * identifier.
 *
 * The scheme and port come from `PUBLIC_URL` because behind a TLS-terminating
 * proxy Fastify reports `http` unless told to trust forwarded headers, and an
 * issuer that says `http` where the relying party saw `https` fails discovery
 * with a message that points nowhere useful.
 */
export interface ProtocolIdentity {
  /** Scheme, host and port. No trailing slash. */
  base: string;
  /** The OIDC issuer. `oidc-provider` is constructed with exactly this. */
  issuer: string;
  /** The SAML IdP entity ID. */
  entityId: string;
  ssoUrl: string;
  sloUrl: string;
  /** Where a WS-Federation relying party sends its passive requests. */
  wsFedUrl: string;
  /** The host the request must have arrived on. Lower case, no port. */
  acsHost: string;
}

export function tenantProtocolIdentity(
  tenant: { primaryDomain: string | null },
  publicUrl: string,
): ProtocolIdentity {
  const fallback = new URL(publicUrl);
  const host = tenant.primaryDomain ?? fallback.hostname;
  const port = fallback.port ? `:${fallback.port}` : '';
  const base = `${fallback.protocol}//${host}${port}`;

  return {
    base,
    issuer: `${base}/oidc`,
    entityId: `${base}/saml/idp`,
    ssoUrl: `${base}/saml/sso`,
    sloUrl: `${base}/saml/slo`,
    // Under `/saml` because it is the SAML machinery. WS-Fed names no
    // well-known path, so this is simply the URL the metadata publishes and
    // the console shows.
    wsFedUrl: `${base}/saml/wsfed`,
    acsHost: host.toLowerCase(),
  };
}

/**
 * Refuses a protocol request that did not arrive on the host the tenant's own
 * identifiers name.
 *
 * Without this the derivation above is only half a control: an assertion
 * built with the correct issuer is still delivered over a connection the
 * browser believes belongs to `sso.acme.test.attacker.example`, and every
 * cookie and every relay-state round trip in the flow happens on that origin.
 * Applied at the first hook of every protocol route.
 */
export function assertProtocolHost(
  request: FastifyRequest,
  identity: ProtocolIdentity,
): void {
  const host = (request.headers.host ?? '').split(':')[0]!.toLowerCase();
  if (host !== '' && host === identity.acsHost) return;

  throw new ProblemError(
    421,
    'wrong-protocol-host',
    'Wrong address for this organization',
    `Single sign-on for this organization is served at ${identity.acsHost}. This request arrived at ${host || '(no host)'}.`,
  );
}
