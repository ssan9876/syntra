import * as client from 'openid-client';
import { guardedFetch } from '@syntra/core';

/**
 * Discovers an upstream provider and builds a client configuration.
 *
 * `openid-client` v6 is functional, not the v5 class API: `discovery()`
 * fetches `.well-known/openid-configuration`, validates the issuer, and
 * returns a `Configuration` every other call takes as its first argument.
 *
 * This performs a network fetch, so it is called outside every transaction —
 * Global Constraint 1, and this is the exact shape that violated it before: an
 * HTTP round trip to a third party, over a link Syntra does not control,
 * inside a 5000 ms transaction budget.
 */
export async function upstreamOidcConfig(
  upstream: { issuerUrl: string; clientId: string },
  clientSecret: string | null,
  outbound: { allowPrivateAddresses: boolean },
): Promise<client.Configuration> {
  const fetcher = guardedFetch({
    allowPrivateAddresses: outbound.allowPrivateAddresses,
  });

  return client.discovery(
    new URL(upstream.issuerUrl),
    upstream.clientId,
    undefined,
    clientSecret === null ? client.None() : client.ClientSecretBasic(clientSecret),
    {
      // Discovery, the JWKS fetch and the token exchange all go through this,
      // and the issuer URL came from an administrator. The same guard as
      // metadata import (Task 2), reached through the same classifier, with
      // the connection pinned to the address that was checked. The switch is
      // the same too: a self-hosted deployment federating to an on-premises
      // provider sets OUTBOUND_ALLOW_PRIVATE, and one that has not set it does
      // not reach its own network by accident.
      [client.customFetch]: (url: string, options: client.CustomFetchOptions) =>
        fetcher(url, options as unknown as RequestInit),
      execute: [
        // `openid-client` does NOT verify an id_token's signature by default.
        // OpenID Connect Core 3.1.3.7 permits skipping it when the token came
        // straight from the token endpoint over an authenticated channel, and
        // that is the library's default — with it, a token signed by a key the
        // upstream has never published is accepted, and the only thing
        // standing behind the identity is TLS to the token endpoint. Two
        // reasons that is not enough here: this deployment allows a
        // plain-HTTP link to an on-premises provider, where the channel
        // authenticates nothing at all; and the id_token is the record a local
        // account gets provisioned from, so it has to be verifiable on its own
        // afterwards. One JWKS fetch, cached on the configuration.
        client.enableNonRepudiationChecks,
        // Only alongside the private-address allowance, and for the same
        // deployment: an on-premises provider on a plain-HTTP link. A public
        // issuer reached over http is a downgrade, and refusing it is the
        // shipped default.
        ...(outbound.allowPrivateAddresses ? [client.allowInsecureRequests] : []),
      ],
    },
  );
}

export function upstreamAuthorizationUrl(
  config: client.Configuration,
  input: {
    redirectUri: string;
    scopes: string[];
    state: string;
    nonce: string;
    codeChallenge: string;
  },
): URL {
  return client.buildAuthorizationUrl(config, {
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(' '),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
}

export const newVerifier = client.randomPKCECodeVerifier;
export const challengeFor = client.calculatePKCECodeChallenge;
export const newNonce = client.randomNonce;

/**
 * Exchanges the code and returns the verified id_token claims.
 *
 * `state`, `nonce` and the PKCE verifier are all passed as expectations rather
 * than checked afterwards: `authorizationCodeGrant` refuses the exchange if
 * any of them fails, and a check that happens inside the library cannot be
 * forgotten by a caller. The claims come out of a signature the library
 * verified against the upstream's published JWKS, with the issuer and the
 * audience checked against this configuration — a token minted by the wrong
 * provider, for the wrong client, or signed by a key the upstream does not
 * publish never reaches the return statement.
 *
 * `redirect_uri` is derived from `currentUrl`, which the caller builds from
 * the tenant's own identity rather than from the `Host` header.
 */
export async function upstreamExchange(
  config: client.Configuration,
  currentUrl: URL,
  checks: { verifier: string; state: string; nonce: string },
): Promise<{ claims: Record<string, unknown>; accessToken: string }> {
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: checks.verifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('upstream returned no id_token');
  return { claims: claims as Record<string, unknown>, accessToken: tokens.access_token };
}

/** UserInfo, for an upstream whose id_token carries a thin claim set. */
export async function upstreamUserInfo(
  config: client.Configuration,
  accessToken: string,
  expectedSubject: string,
): Promise<Record<string, unknown>> {
  return (await client.fetchUserInfo(config, accessToken, expectedSubject)) as Record<
    string,
    unknown
  >;
}
