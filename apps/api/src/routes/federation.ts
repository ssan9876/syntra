import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  authorize,
  evaluateRouting,
  findUpstream,
  linkOrProvision,
  loadPolicy,
  localMasterKeyProvider,
  mapClaims,
  openFederationRequest,
  recordEvent,
  takeFederationRequest,
  upstreamClientSecret,
  type ProvisionRefusal,
  type UpstreamIdpRecord,
} from '@syntra/core';
import {
  challengeFor,
  newNonce,
  newVerifier,
  upstreamAuthorizationUrl,
  upstreamExchange,
  upstreamOidcConfig,
  upstreamUserInfo,
} from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { assertProtocolHost, tenantProtocolIdentity } from './protocol-identity.js';
import { tenantRelyingParty } from './relying-party.js';
import { issueSession } from './session-reply.js';

export interface FederationRouteOptions {
  publicUrl: string;
  masterKey: Buffer;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
  /** From `OUTBOUND_ALLOW_PRIVATE`. See Task 2. */
  outboundAllowPrivate: boolean;
}

/**
 * Where the browser may be sent back to after federation.
 *
 * A path on this origin and nothing else. A callback that redirects to
 * whatever `returnTo` said is an open redirect on an endpoint an attacker can
 * aim at any user, and it is the specific bug that turns a federation flow
 * into a phishing tool. Protocol-relative (`//evil.test`) and backslash forms
 * are rejected explicitly because `new URL('//evil.test', base)` resolves to
 * the attacker's host, and browsers normalise a backslash to a slash.
 */
function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/** What the user is told when their identity provider produced no account. */
const REFUSAL_DETAIL: Record<ProvisionRefusal, string> = {
  no_local_user:
    'You signed in successfully, but this organization has no account for you. Ask an administrator to create one.',
  incomplete_profile:
    'That identity provider did not send enough information to identify you.',
  link_conflict:
    'Another identity from that provider already uses this account. Ask an administrator to sort it out before signing in again.',
};

export async function registerFederationRoutes(
  app: FastifyInstance,
  options: FederationRouteOptions,
): Promise<void> {
  const rateLimited = {
    config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };
  const keyProvider = () => localMasterKeyProvider(options.masterKey);

  /**
   * Builds the client configuration, or refuses in a way a browser can read.
   *
   * Discovery is a network fetch through the outbound guard, and its failures
   * — a provider that is down, an issuer that resolves inside this deployment
   * — are configuration problems rather than bugs. They are logged in full and
   * reported without detail: the guard's message names the address the
   * hostname resolved to, and that is internal topology.
   */
  const configureUpstream = async (
    request: FastifyRequest,
    upstream: UpstreamIdpRecord,
  ) => {
    if (upstream.protocol !== 'oidc' || !upstream.issuerUrl || !upstream.clientId) {
      throw new ProblemError(
        409,
        'federation-misconfigured',
        'That identity provider is not usable',
      );
    }
    // Network I/O and a vault read, both outside every transaction.
    const secret = await upstreamClientSecret(
      request.tenantId,
      keyProvider(),
      upstream.id,
    );
    try {
      return await upstreamOidcConfig(
        { issuerUrl: upstream.issuerUrl, clientId: upstream.clientId },
        secret,
        { allowPrivateAddresses: options.outboundAllowPrivate },
      );
    } catch (error) {
      request.log.warn({ err: error, upstreamIdpId: upstream.id }, 'upstream discovery failed');
      throw new ProblemError(
        502,
        'federation-upstream-unreachable',
        'That identity provider could not be reached',
        'Syntra could not read the identity provider’s configuration. An administrator should check the issuer address.',
      );
    }
  };

  /**
   * Asks the policy which upstream this login uses, and starts it.
   *
   * The routing rules decide — spec section 7 — and they decide on facts
   * available before the user is known. Nothing here authorizes anything; the
   * decision that matters is `authorize()` in the callback below.
   */
  app.get('/start', rateLimited, async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    assertProtocolHost(request, identity);

    const query = request.query as Record<string, string | undefined>;
    const returnTo = safeReturnTo(query.next);

    const { routes } = await request.db((tx) => loadPolicy(tx));
    const routed = evaluateRouting(routes, {
      login: query.login ?? null,
      applicationId: query.applicationId ?? null,
      sourceIp: request.ip,
      now: new Date(),
    });
    if (!routed) {
      // No rule matched. Local authentication, which is the default and is
      // never an error.
      return reply.redirect(`/login?next=${encodeURIComponent(returnTo)}`, 302);
    }

    const upstream = await findUpstream(request.tenantId, routed.upstreamIdpId);
    if (!upstream) {
      throw new ProblemError(
        409,
        'federation-misconfigured',
        'That identity provider is not usable',
      );
    }
    const config = await configureUpstream(request, upstream);

    const verifier = newVerifier();
    const nonce = newNonce();
    const codeChallenge = await challengeFor(verifier);
    const ticket = await openFederationRequest(request.tenantId, {
      upstreamIdpId: upstream.id,
      returnTo,
      applicationId: query.applicationId ?? null,
      nonce,
      verifier,
      provider: keyProvider(),
    });

    const url = upstreamAuthorizationUrl(config, {
      // The redirect URI is built from the tenant's own identity, so the
      // upstream sends the code back to Syntra's real host rather than to
      // whatever the Host header said.
      redirectUri: `${identity.base}/federation/oidc/callback`,
      scopes: upstream.scopes,
      state: ticket.state,
      nonce,
      codeChallenge,
    });

    return reply.redirect(url.href, 302);
  });

  app.get('/oidc/callback', rateLimited, async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    assertProtocolHost(request, identity);

    const query = request.query as Record<string, string | undefined>;
    if (typeof query.state !== 'string') {
      throw new ProblemError(400, 'federation-bad-callback', 'Missing state');
    }

    // Single-use. A replayed callback finds nothing.
    const ticket = await takeFederationRequest(
      request.tenantId,
      query.state,
      keyProvider(),
    );
    if (!ticket) {
      throw new ProblemError(
        400,
        'federation-bad-callback',
        'That sign-in has expired or was already used',
      );
    }

    const upstream = await findUpstream(request.tenantId, ticket.upstreamIdpId);
    if (!upstream || !ticket.verifier || !ticket.nonce) {
      throw new ProblemError(
        409,
        'federation-misconfigured',
        'That identity provider is not usable',
      );
    }

    const config = await configureUpstream(request, upstream);

    // The exchange verifies the id_token signature against the upstream's
    // published JWKS and checks the issuer, the audience, the nonce, the state
    // and the PKCE verifier. All network work, all outside any transaction.
    //
    // Every one of those failures is one message to the browser. A response
    // that distinguished "wrong nonce" from "wrong signature" would tell
    // whoever is feeding Syntra a forged token which check they have yet to
    // satisfy; the detail goes to the log instead.
    let claims: Record<string, unknown>;
    let accessToken: string;
    try {
      ({ claims, accessToken } = await upstreamExchange(
        config,
        new URL(request.raw.url ?? '', identity.base),
        { verifier: ticket.verifier, state: ticket.state, nonce: ticket.nonce },
      ));
    } catch (error) {
      request.log.warn(
        { err: error, upstreamIdpId: upstream.id },
        'upstream token exchange refused',
      );
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: null,
          action: 'federation.exchange_refused',
          targetType: 'UpstreamIdp',
          targetId: upstream.id,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: { upstream: upstream.name },
        }),
      );
      throw new ProblemError(
        401,
        'federation-token-rejected',
        'That sign-in could not be verified',
      );
    }

    let profile = mapClaims(upstream, claims);
    if (profile.subject === '') {
      throw new ProblemError(
        401,
        'federation-token-rejected',
        'That sign-in could not be verified',
      );
    }

    // A thin id_token is common — several providers put everything but `sub`
    // behind UserInfo — and refusing the login because the claim set was small
    // would be Syntra reporting its own missing second request as the tenant's
    // misconfiguration. Asked only when the mapping found no identifier at
    // all, so the ordinary login stays one round trip. `fetchUserInfo` is given
    // the subject the id_token carried and refuses a response naming a
    // different one, so this cannot widen who is being signed in. Network work,
    // outside every transaction, and a failure here leaves the refusal to
    // `linkOrProvision`.
    if (profile.login === null && profile.email === null) {
      try {
        const info = await upstreamUserInfo(config, accessToken, profile.subject);
        profile = mapClaims(upstream, { ...claims, ...info, sub: profile.subject });
      } catch (error) {
        request.log.warn(
          { err: error, upstreamIdpId: upstream.id },
          'upstream userinfo unavailable',
        );
      }
    }

    const provisioned = await linkOrProvision(request.tenantId, upstream, profile);

    if (provisioned.userId === null) {
      // A refusal is recorded, never dropped. An administrator asked why a
      // colleague cannot sign in needs the reason to exist somewhere.
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: null,
          action: 'federation.provision_refused',
          targetType: 'UpstreamIdp',
          targetId: upstream.id,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: { reason: provisioned.reason, subject: profile.subject },
        }),
      );
      throw new ProblemError(
        403,
        'federation-no-account',
        'No account here',
        REFUSAL_DETAIL[provisioned.reason],
      );
    }

    // THE CHOKEPOINT. The upstream asserted who they are; whether they may
    // have a Syntra session is decided here, with the full policy — including
    // a second factor on top of the upstream, and including deny. Nothing
    // above this line mints anything.
    const decision = await authorize(request.tenantId, {
      kind: 'primary',
      principal: {
        kind: 'external',
        userId: provisioned.userId,
        // Goes into the audit event, so a decision traces back to who
        // vouched for the identity.
        issuer: upstream.issuerUrl!,
      },
      applicationId: ticket.applicationId,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
      scope: 'portal',
    });

    if (decision.status === 'deny') {
      throw new ProblemError(403, 'federation-denied', 'Sign-in refused');
    }

    if (decision.status === 'challenge' || decision.status === 'enrol') {
      const next = encodeURIComponent(ticket.returnTo);
      const path = decision.status === 'challenge' ? '/mfa' : '/enrol';
      return reply.redirect(
        `${path}?attempt=${encodeURIComponent(decision.attemptToken)}&next=${next}`,
        302,
      );
    }

    // `issueSession` takes the allow object and nothing else, so this cannot
    // mint a session for a user the decision did not name.
    await issueSession(request, reply, decision);
    return reply.redirect(ticket.returnTo, 302);
  });
}
