import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import {
  authorize,
  browserBindingDigest,
  evaluateRouting,
  findUpstream,
  findUpstreamBySlug,
  linkOrProvision,
  loadPolicy,
  localMasterKeyProvider,
  mapClaims,
  newBrowserBinding,
  openFederationRequest,
  recordEvent,
  takeFederationRequest,
  upstreamClientSecret,
  type AuthorizeResult,
  type ProvisionRefusal,
  type UpstreamIdpRecord,
  type UpstreamProfile,
} from '@syntra/core';
import {
  challengeFor,
  newAuthnRequestId,
  newNonce,
  newVerifier,
  readUpstreamResponse,
  upstreamAuthnRedirect,
  upstreamAuthorizationUrl,
  upstreamExchange,
  upstreamOidcConfig,
  upstreamSaml,
  upstreamSpMetadata,
  upstreamUserInfo,
  type UpstreamSamlOptions,
} from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import {
  assertProtocolHost,
  tenantProtocolIdentity,
  type ProtocolIdentity,
} from './protocol-identity.js';
import { tenantRelyingParty } from './relying-party.js';
import { challengeRedirect, issueSession } from './session-reply.js';

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

/**
 * The cookie that ties an in-flight upstream login to the browser that started
 * it.
 *
 * Without it, the callback URL is an unbound bearer credential. An attacker
 * starts a federation login in their own browser, completes it at the upstream
 * as themselves, and — instead of following the redirect — copies it and sends
 * it to a victim. The victim's browser loads it; the PKCE verifier, the nonce
 * and the expected `InResponseTo` all come off the ROW rather than the
 * browser, so the exchange succeeds, `linkOrProvision` returns the ATTACKER's
 * user id, `authorize()` allows, and `issueSession` writes a Syntra session
 * for the attacker's account into the victim's browser. The victim then works
 * inside an account somebody else controls: what they upload lands there, and
 * a second factor they enrol at the prompt is enrolled on the attacker's
 * account.
 *
 * `state` does not close this. Stored server-side and looked up, it is a
 * single-use replay defence; it is a CSRF defence only when it is bound to a
 * browser (RFC 6819 section 4.4.1.8). Nor do the checks commit `6eae978`
 * added — signed issuer, `InResponseTo` against the stored request ID,
 * `Recipient` naming this ACS. Those defend the other direction, and they all
 * pass here, because the assertion genuinely is the attacker's and genuinely
 * answers the attacker's own request.
 *
 * This mirrors `SAML_BINDING_COOKIE` in `saml-idp.ts`, which closed the same
 * defect on the identity-provider side of the same branch, down to the cookie
 * options and the reasoning about `sameSite`: a Lax cookie *is* sent on a
 * cross-site top-level GET — which is the shape of the OIDC attack — and on a
 * cross-site form POST it is not, which is why the SAML ACS reads it too
 * rather than relying on that. The binding check is what makes both safe.
 *
 * Scoped to `/federation`, because no other route reads it. Only its digest is
 * stored, so the row is not a credential.
 */
const FEDERATION_BINDING_COOKIE = 'syntra_federation_bind';

const FEDERATION_BINDING_COOKIE_OPTIONS = {
  httpOnly: true,
  // Not `strict`. The SAML assertion arrives as a cross-site form POST from
  // the upstream, and a Strict cookie is not sent on one — the binding would
  // then fail for every legitimate SAML login rather than for the attack.
  sameSite: 'lax' as const,
  path: '/federation',
  // Follows NODE_ENV for the same reason the session cookie does: a
  // development server runs on plain HTTP and a Secure cookie would never come
  // back, which reads as "single sign-on is broken".
  secure: process.env.NODE_ENV === 'production',
  // Comfortably longer than an in-flight login's ten minutes, so the row is
  // what expires the flow and not the cookie, and re-issued on every start.
  maxAge: 30 * 60,
};

/**
 * The binding digest to open a request under, setting the cookie if this
 * browser has none yet.
 *
 * The existing nonce is reused rather than replaced because one browser can
 * have several sign-ins in flight at once — two tabs entering two
 * applications — and a fresh nonce per start would invalidate every earlier
 * tab's callback.
 */
function bindBrowser(request: FastifyRequest, reply: FastifyReply): string {
  const existing = request.cookies[FEDERATION_BINDING_COOKIE];
  if (typeof existing === 'string' && existing !== '') {
    return browserBindingDigest(existing);
  }
  const { nonce, digest } = newBrowserBinding();
  reply.setCookie(FEDERATION_BINDING_COOKIE, nonce, FEDERATION_BINDING_COOKIE_OPTIONS);
  return digest;
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
  // The SAML ACS receives `application/x-www-form-urlencoded`. Scoped to this
  // plugin by Fastify's encapsulation, exactly as `saml-idp.ts` does it:
  // registering it at the root would drain the body of every `/oidc/*`
  // request, which `oidc-provider` reads from the raw stream itself, and
  // `oidc-boundary.test.ts` asserts the root has no such parser.
  await app.register(formbody);

  const rateLimited = {
    config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };
  const keyProvider = () => localMasterKeyProvider(options.masterKey);

  /**
   * Syntra's service-provider identity for an upstream.
   *
   * Both URLs come from `tenantProtocolIdentity` and neither from the request,
   * so the entity ID an upstream checks its audience against — and the ACS URL
   * the assertion must name as its `Recipient` — are values the tenant's own
   * configuration decides. Deriving either from `Host` would let whoever
   * chooses the header choose the identifier being checked, which is the whole
   * content of the check.
   *
   * The entity ID does not vary by upstream. It does not have to: what
   * separates two upstreams of one tenant is the certificate that signed the
   * assertion and the `FederationRequest` row the RelayState resolves to, and
   * an upstream can only ever assert subjects in its own `UpstreamLink`
   * namespace.
   */
  const samlOptionsFor = (
    upstream: UpstreamIdpRecord,
    identity: ProtocolIdentity,
    requestId?: string,
  ): UpstreamSamlOptions => ({
    idpCertificates: upstream.idpCertificates,
    idpEntityId: upstream.idpEntityId,
    ssoUrl: upstream.ssoUrl ?? '',
    sloUrl: upstream.idpSloUrl,
    spEntityId: `${identity.base}/federation/saml/metadata`,
    acsUrl: `${identity.base}/federation/saml/acs`,
    wantAssertionsSigned: upstream.wantAssertionsSigned,
    ...(requestId ? { requestId } : {}),
  });

  /**
   * Turns an upstream identity into a local account, then asks `authorize()`.
   *
   * Shared by both protocols on purpose. The upstream's word is evidence, and
   * what it is evidence *of* differs between an id_token and an assertion; what
   * may be done with it does not, and a second copy of this block is a second
   * place for the chokepoint to drift out of.
   */
  const completeLogin = async (
    request: FastifyRequest,
    upstream: UpstreamIdpRecord,
    profile: UpstreamProfile,
    issuer: string,
    ticket: { applicationId: string | null },
    tenant: { primaryDomain: string | null },
  ): Promise<AuthorizeResult> => {
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
    return authorize(request.tenantId, {
      kind: 'primary',
      principal: {
        kind: 'external',
        userId: provisioned.userId,
        // Goes into the audit event, so a decision traces back to who
        // vouched for the identity.
        issuer,
      },
      applicationId: ticket.applicationId,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
      scope: 'portal',
    });
  };

  /** The three ways a decision ends, for a browser. */
  const replyToDecision = async (
    request: FastifyRequest,
    reply: FastifyReply,
    decision: AuthorizeResult,
    returnTo: string,
  ) => {
    if (decision.status === 'deny') {
      throw new ProblemError(403, 'federation-denied', 'Sign-in refused');
    }
    if (decision.status === 'challenge' || decision.status === 'enrol') {
      return challengeRedirect(reply, decision, returnTo);
    }
    // `issueSession` takes the allow object and nothing else, so this cannot
    // mint a session for a user the decision did not name.
    await issueSession(request, reply, decision);
    return reply.redirect(returnTo, 302);
  };

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
    if (upstream.protocol === 'saml') {
      if (!upstream.ssoUrl || upstream.idpCertificates.length === 0) {
        // No SSO URL is nowhere to send them; no certificate is nothing to
        // check the answer against, and a login that could never be verified
        // is better refused before the browser leaves than after it comes
        // back.
        throw new ProblemError(
          409,
          'federation-misconfigured',
          'That identity provider is not configured',
        );
      }
      // The ID the assertion has to echo. Minted here and stored on the
      // single-use request row, because a response can only be tied to a
      // request Syntra really started if Syntra wrote the request's name down
      // first — RelayState alone proves only that *somebody* started a login,
      // and the attacker can start one.
      const requestId = newAuthnRequestId();
      const ticket = await openFederationRequest(request.tenantId, {
        upstreamIdpId: upstream.id,
        returnTo,
        applicationId: query.applicationId ?? null,
        browserBinding: bindBrowser(request, reply),
        nonce: requestId,
      });
      const sp = upstreamSaml(samlOptionsFor(upstream, identity, requestId));
      // Deflating and building the request, outside every transaction.
      return reply.redirect(await upstreamAuthnRedirect(sp, ticket.state), 302);
    }

    const config = await configureUpstream(request, upstream);

    const verifier = newVerifier();
    const nonce = newNonce();
    const codeChallenge = await challengeFor(verifier);
    const ticket = await openFederationRequest(request.tenantId, {
      upstreamIdpId: upstream.id,
      returnTo,
      applicationId: query.applicationId ?? null,
      browserBinding: bindBrowser(request, reply),
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

    // Single-use, and bound to the browser that started the login. A replayed
    // callback finds nothing; one presented by a browser that did not start
    // this login is refused in exactly the same way, and neither is told
    // which.
    const ticket = await takeFederationRequest(
      request.tenantId,
      query.state,
      request.cookies[FEDERATION_BINDING_COOKIE] ?? null,
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

    const decision = await completeLogin(
      request,
      upstream,
      profile,
      upstream.issuerUrl!,
      ticket,
      tenant,
    );
    return replyToDecision(request, reply, decision, ticket.returnTo);
  });

  /**
   * Syntra's own SP metadata, for an administrator to hand to the upstream.
   *
   * Unauthenticated and rate limited, like `/saml/metadata` on the
   * identity-provider side. `?upstream=<slug>` reflects one upstream's
   * `WantAssertionsSigned`; without it the document states the shipped
   * default, which is the stronger of the two, because the entity ID an
   * administrator will paste into their IdP is this URL with no query string.
   */
  app.get('/saml/metadata', rateLimited, async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    assertProtocolHost(request, identity);

    const slug = (request.query as Record<string, string | undefined>).upstream;
    const upstream = slug ? await findUpstreamBySlug(request.tenantId, slug) : null;
    if (slug && (!upstream || upstream.protocol !== 'saml')) {
      throw new ProblemError(
        404,
        'federation-unknown-upstream',
        'Unknown identity provider',
      );
    }

    return reply.type('application/samlmetadata+xml').send(
      upstreamSpMetadata({
        idpCertificates: upstream?.idpCertificates ?? [],
        idpEntityId: upstream?.idpEntityId ?? null,
        ssoUrl: upstream?.ssoUrl ?? '',
        sloUrl: upstream?.idpSloUrl ?? null,
        spEntityId: `${identity.base}/federation/saml/metadata`,
        acsUrl: `${identity.base}/federation/saml/acs`,
        wantAssertionsSigned: upstream?.wantAssertionsSigned ?? true,
      }),
    );
  });

  app.post('/saml/acs', rateLimited, async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    assertProtocolHost(request, identity);

    const body = request.body as Record<string, unknown> | undefined;
    const relayState = body?.RelayState;
    const samlResponse = body?.SAMLResponse;
    // A duplicated parameter arrives as an array, which is the oldest way of
    // getting two readers to disagree about which value is "the" value.
    if (typeof relayState !== 'string' || typeof samlResponse !== 'string') {
      throw new ProblemError(400, 'federation-bad-callback', 'Malformed response');
    }

    // Single-use, and one of the three things that tie this response to a
    // login this browser started. The AuthnRequest ID below ties it to a
    // request SYNTRA started; the browser binding ties it to the browser that
    // asked for it. RelayState alone proves only that somebody started a
    // login, and an attacker holding a captured assertion can start one of
    // their own and post it into somebody else's browser.
    const ticket = await takeFederationRequest(
      request.tenantId,
      relayState,
      request.cookies[FEDERATION_BINDING_COOKIE] ?? null,
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
    if (!upstream || upstream.protocol !== 'saml' || !upstream.ssoUrl || !ticket.nonce) {
      // `ticket.nonce` carries the AuthnRequest ID for a SAML login. A ticket
      // without one was opened by the OIDC branch, and there is nothing to
      // bind the assertion to.
      throw new ProblemError(
        409,
        'federation-misconfigured',
        'That identity provider is not usable',
      );
    }

    // Signature verification and XML parsing, outside every transaction. It
    // throws on any failure and there is no path past it: the value it returns
    // is read from the bytes the signature covered, and the `samlp:Response`
    // that carried them is never read here.
    const sp = upstreamSaml(samlOptionsFor(upstream, identity));

    let assertion;
    try {
      assertion = await readUpstreamResponse(sp, samlResponse, {
        inResponseTo: ticket.nonce,
      });
    } catch (cause) {
      request.log.warn(
        { err: cause, upstreamIdpId: upstream.id },
        'upstream assertion refused',
      );
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: null,
          action: 'federation.assertion_refused',
          targetType: 'UpstreamIdp',
          targetId: upstream.id,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: { upstream: upstream.name },
        }),
      );
      // One sentence for every failure. A response that distinguished "wrong
      // issuer" from "wrong signature" would tell whoever is feeding Syntra a
      // forged assertion which check they have yet to satisfy.
      throw new ProblemError(
        400,
        'federation-bad-assertion',
        'That sign-in could not be verified',
      );
    }

    // The same mapping rules as OIDC — a value that is not a non-empty string
    // is absent, a single group name is a one-element list — so the
    // provisioning decision cannot differ between the two protocols. The
    // NameID is assigned last, so an upstream attribute literally named `sub`
    // cannot displace the identity the signature carried.
    const claims: Record<string, unknown> = {};
    for (const [name, values] of Object.entries(assertion.attributes)) {
      claims[name] = values.length === 1 ? values[0] : values;
    }
    claims.sub = assertion.subject;

    const decision = await completeLogin(
      request,
      upstream,
      mapClaims(upstream, claims),
      assertion.issuer,
      ticket,
      tenant,
    );
    return replyToDecision(request, reply, decision, ticket.returnTo);
  });
}
