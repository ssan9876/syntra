import type { FastifyRequest } from 'fastify';
import type { RelyingParty } from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';

/**
 * The WebAuthn relying party for a tenant.
 *
 * From the tenant's own configuration, never from the request. `Host` is
 * attacker-controlled and `tenant-context.ts` resolves a tenant from its
 * leftmost label, so `acme.attacker.example` resolves tenant `acme` — deriving
 * the RP ID or the expected origin from that header lets a phisher choose what
 * their own assertion is checked against, which is precisely the property a
 * security key exists to provide. Checking the stored `rpId` on the credential
 * afterwards does not help, because a registration performed in the same
 * phishing flow stamps the attacker's RP ID onto the row.
 *
 * The scheme and port come from `PUBLIC_URL`: behind a TLS-terminating proxy
 * Fastify reports `http` unless it is told to trust the forwarded headers, and
 * a wrong expected origin fails every assertion with a message that points
 * nowhere useful.
 */
export function tenantRelyingParty(
  tenant: { primaryDomain: string | null },
  publicUrl: string,
): RelyingParty {
  const base = new URL(publicUrl);
  if (!tenant.primaryDomain) {
    // No primary domain configured. This is a usable relying party for a
    // single-tenant deployment served straight off PUBLIC_URL; for anything
    // else the Host check below refuses WebAuthn until an administrator sets
    // one. That refusal is correct — there is no safe way to guess a tenant's
    // own origin, and guessing it from the request is the vulnerability.
    return { id: base.hostname, origin: base.origin };
  }
  const port = base.port ? `:${base.port}` : '';
  return {
    id: tenant.primaryDomain,
    origin: `${base.protocol}//${tenant.primaryDomain}${port}`,
  };
}

/**
 * Refuses a WebAuthn operation whose request did not arrive on the tenant's own
 * host.
 *
 * Applied at the WebAuthn endpoints only. Password authentication does not care
 * what the relying party is, and refusing a sign-in because a tenant has not
 * configured a primary domain would be a worse failure than the one being
 * prevented.
 */
export function assertWebAuthnUsable(
  request: FastifyRequest,
  tenant: { primaryDomain: string | null },
  rp: RelyingParty,
): void {
  const host = (request.headers.host ?? '').split(':')[0]!.toLowerCase();
  if (host === rp.id.toLowerCase()) return;

  throw new ProblemError(
    409,
    'webauthn-unavailable',
    'Security keys are not available on this address',
    tenant.primaryDomain
      ? `This tenant registers security keys against ${rp.id}. Sign in at that address to use one.`
      : 'An administrator must set this tenant a primary domain before security keys can be used. Until then, use an authenticator app.',
  );
}
