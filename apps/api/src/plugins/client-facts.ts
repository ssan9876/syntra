import type { FastifyRequest } from 'fastify';
import type { ClientFacts } from '@syntra/core';

/**
 * What a request says about where it came from, for the policy engine.
 *
 * One reader, used at every `authorize()` call site, because a policy that
 * applies on the password screen and not on the SAML one is worse than no
 * policy: an administrator reads a rule that says "not from a phone" and has
 * no way to discover that one of five entry points ignores it.
 * `client-facts.test.ts` holds that invariant against the routes.
 */

/**
 * The header carrying the country, named by the deployment.
 *
 * Read per call rather than captured at import, so a test can set it and so a
 * restart is not needed to correct a typo in it. Unset — the default, and the
 * state of every deployment that has not configured a proxy that knows the
 * country — leaves every country condition unevaluable.
 *
 * Cloudflare sends `cf-ipcountry`; most other proxies are configured by hand,
 * so there is no useful default to guess. Guessing one would be worse than
 * none: a header an untrusted client can set is a header a client can use to
 * claim a country, and naming it explicitly is the deployment stating that it
 * strips and re-sets that header at its edge.
 */
export function countryHeaderName(): string | null {
  const name = (process.env.POLICY_COUNTRY_HEADER ?? '').trim().toLowerCase();
  return name === '' ? null : name;
}

export function clientFacts(request: FastifyRequest): ClientFacts {
  const name = countryHeaderName();
  const raw = name === null ? undefined : request.headers[name];
  return {
    userAgent: request.headers['user-agent'] ?? null,
    // A repeated header arrives as an array. Taking the first is the same
    // choice a proxy makes, and an array at all means something upstream is
    // appending rather than replacing — which the deployment note above says
    // it must not do.
    countryHeader: Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null),
  };
}
