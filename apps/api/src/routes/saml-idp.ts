import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import { idParam } from '@syntra/contracts';
import {
  authorize,
  browserBindingDigest,
  collectSubjectFacts,
  consumeParkedAuthnRequest,
  endSsoSessions,
  ensureActiveKey,
  findApplication,
  findParkedAuthnRequest,
  findSamlConfigByEntityId,
  findSamlConfigForApplication,
  isApplicationAssigned,
  listClaimMappings,
  loadActiveKey,
  localMasterKeyProvider,
  newBrowserBinding,
  parkAuthnRequest,
  publishedKeys,
  recordEvent,
  resolveAcsUrl,
  resolveClaims,
  resolveSession,
  startSamlSsoSession,
  type ParkedAuthnRequest,
  type SamlConfigRecord,
} from '@syntra/core';
import {
  buildIdpMetadata,
  buildLogoutResponse,
  buildSignedResponse,
  decodePostMessage,
  decodeRedirectMessage,
  encryptAssertion,
  logoutPostForm,
  parseAuthnRequest,
  parseLogoutRequest,
  postBindingForm,
  verifyPostSignature,
  verifyRedirectSignature,
} from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import { assertProtocolHost, tenantProtocolIdentity } from './protocol-identity.js';
import { tenantRelyingParty } from './relying-party.js';

/**
 * The SAML authentication context class that corresponds to the factor the
 * session was actually established with. A service provider that makes its own
 * decisions from the AuthnContext gets an honest answer rather than a constant.
 */
const AUTHN_CONTEXT: Record<string, string> = {
  totp: 'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken',
  webauthn: 'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract',
  recovery_code: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
};
const DEFAULT_AUTHN_CONTEXT =
  'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';

/**
 * The cookie that ties a parked sign-in request to the browser that started
 * it.
 *
 * Without it, the handle in `/saml/continue?handle=...` is an unbound bearer
 * credential: whoever can make Syntra park a request can read the handle out
 * of the 302 `Location` and hand that URL to a logged-in victim, which mints
 * an assertion *for the victim* and auto-posts it to the service provider's
 * real ACS. That is login CSRF reached around `allowIdpInitiated: false`, the
 * very setting whose purpose is to suppress it, and nothing else on the parked
 * row identifies a browser.
 *
 * `wantAuthnRequestsSigned` now defaults to true (ruling A2-10), which raises
 * the bar to "whoever holds the service provider's signing key" — but this
 * binding is the control that does not depend on that setting, and an
 * application whose administrator deliberately turned it off still has it.
 *
 * The value is a nonce, not a session: the sign-in it eventually authenticates
 * need not exist yet, and forcing a session first would break the ordinary
 * "service provider sends you here, then you log in" flow. Only its digest is
 * stored, so the row is not a credential.
 *
 * Scoped to `/saml`, because no other route reads it. `sameSite: 'lax'`
 * matches the session cookie; it is not what makes this safe — a Lax cookie
 * *is* sent on a cross-site top-level GET, which is exactly the shape of the
 * attack — the binding check is. A network attacker who can write cookies for
 * the tenant host (plain HTTP, or a sibling host under the registrable domain)
 * can still toss a nonce of their own choosing; that is the same exposure the
 * session cookie already has, and the answer to it is HTTPS and one host per
 * tenant rather than a second cookie scheme here.
 */
const SAML_BINDING_COOKIE = 'syntra_saml_bind';

const SAML_BINDING_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/saml',
  // Follows NODE_ENV for the same reason the session cookie does: a
  // development server runs on plain HTTP and a Secure cookie would never come
  // back, which reads as "single sign-on is broken".
  secure: process.env.NODE_ENV === 'production',
  // Comfortably longer than a parked request's ten minutes, so the row is what
  // expires the flow and not the cookie, and re-issued on every park.
  maxAge: 30 * 60,
};

/**
 * The binding digest to park a request under, setting the cookie if this
 * browser has none yet.
 *
 * The existing nonce is reused rather than replaced because one browser can
 * have several sign-ins in flight at once — two tabs entering two service
 * providers — and a fresh nonce per park would invalidate every earlier tab's
 * handle.
 */
function bindBrowser(request: FastifyRequest, reply: FastifyReply): string {
  const existing = request.cookies[SAML_BINDING_COOKIE];
  if (typeof existing === 'string' && existing !== '') {
    return browserBindingDigest(existing);
  }
  const { nonce, digest } = newBrowserBinding();
  reply.setCookie(SAML_BINDING_COOKIE, nonce, SAML_BINDING_COOKIE_OPTIONS);
  return digest;
}

/**
 * The raw query substring an HTTP-Redirect signature covers.
 *
 * Lifted out of `request.raw.url` rather than rebuilt from `request.query`,
 * because the signature is over the sender's exact bytes: their
 * percent-encoding, their parameter order, and only the parameters the
 * standard names — `SAMLRequest` (or `SAMLResponse`), then `RelayState` if it
 * is present, then `SigAlg`, in that order and no other. Re-encoding a parsed
 * object produces different bytes and every legitimately signed request fails.
 *
 * `RelayState` is included only when it actually appears, because the sender
 * signed what it sent: adding an empty one changes the bytes.
 *
 * Exported so Task 9's single-logout handler can call it for `SAMLResponse`.
 */
export function signedRedirectQuery(
  rawUrl: string,
  parameter: 'SAMLRequest' | 'SAMLResponse',
): string {
  const start = rawUrl.indexOf('?');
  const query = start < 0 ? '' : rawUrl.slice(start + 1);

  const take = (name: string): string | null => {
    const match = query.match(new RegExp(`(?:^|&)(${name}=[^&]*)`));
    return match ? match[1]! : null;
  };

  const message = take(parameter);
  const sigAlg = take('SigAlg');
  if (message === null || sigAlg === null) {
    throw new ProblemError(400, 'saml-bad-request', 'Malformed SAML request');
  }

  const relayState = take('RelayState');
  return relayState === null
    ? `${message}&${sigAlg}`
    : `${message}&${relayState}&${sigAlg}`;
}

export interface SamlRouteOptions {
  publicUrl: string;
  masterKey: Buffer;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
}

/**
 * Runs a decode or a parse over attacker-supplied bytes and turns a failure
 * into a 400.
 *
 * `parseXml`, `parseAuthnRequest`, `parseLogoutRequest` and the two decoders
 * all throw a plain `Error`, and `problem-json.ts` maps anything that is not a
 * `ProblemError` to a bare 500 — correctly, because an unrecognised throw is a
 * bug. So every malformed unauthenticated SAML input answered 500: undeflated
 * bytes, deflated garbage, a wrong root element, a decompression bomb, a
 * truncated assertion, single-logout garbage. A 500 says "Syntra is broken";
 * these all mean "your message is not a SAML message", and the distinction is
 * the difference between a service provider's integrator fixing their side and
 * filing a bug here. It also keeps a parser failure out of the 5xx alerting
 * that ought to mean something.
 *
 * A `ProblemError` raised inside is passed through untouched — `verify`'s
 * `signedRedirectQuery` already raises its own 400 and must not be relabelled.
 *
 * The parser's own message rides along as `detail`. It is derived entirely
 * from the caller's own bytes and names no server state.
 */
function readSamlInput<T>(what: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof ProblemError) throw cause;
    throw new ProblemError(
      400,
      'saml-malformed',
      `Malformed ${what}`,
      cause instanceof Error ? cause.message : undefined,
    );
  }
}

/**
 * One value for a parameter, or a refusal.
 *
 * Fastify hands back an array when a parameter appears more than once, and the
 * previous `typeof x === 'string'` guards quietly turned that into `null`. For
 * `RelayState` on the Redirect binding that is a divergence between the bytes
 * that were verified and the value that is acted on: `signedRedirectQuery`
 * takes the *first* occurrence into the signed string, the signature checks
 * out over it, and then the route parks nothing. The effect is deep-link
 * denial rather than forgery, but "the signature covered something other than
 * what we used" is not a property to leave standing anywhere in a SAML
 * implementation. A duplicated parameter is refused instead: it has no
 * legitimate sender.
 */
function singleValued(
  source: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = source?.[name];
  if (value === undefined || typeof value === 'string') return value;
  throw new ProblemError(
    400,
    'saml-bad-request',
    'Duplicate SAML parameter',
    `${name} was sent more than once, and only one occurrence can be the one that was signed.`,
  );
}

/**
 * The refusal an operator has to be able to act on without reading a Prisma
 * model.
 *
 * `wantAuthnRequestsSigned` defaults to true (ruling A2-10), which means the
 * commonest first-run failure for a newly registered service provider is a
 * signature check the administrator did not know was on. The setting is named
 * literally, the application is named by the name they see in the console, and
 * both ways out are spelled out — register the certificate, or turn the
 * requirement off for that application deliberately. They are also carried as
 * RFC 9457 extension members so a client can branch on them rather than
 * parsing the prose.
 *
 * The application's name is disclosed to a caller who has already presented a
 * registered service provider entity ID, which is a value published in that
 * service provider's own metadata. The exposure is a display name to somebody
 * who already knows the integration exists; the alternative — an error that
 * makes the administrator go and read `schema.prisma` — costs more.
 */
async function signedRequestRefusal(
  request: FastifyRequest,
  config: SamlConfigRecord,
  refusal:
    | { kind: 'no-certificate'; message: 'AuthnRequest' | 'LogoutRequest' }
    | { kind: 'bad-signature'; message: 'AuthnRequest' | 'LogoutRequest' },
): Promise<ProblemError> {
  const application = await request.db((tx) =>
    findApplication(tx, config.applicationId),
  );
  const name = application?.name ?? config.applicationId;
  const shared =
    `The application "${name}" requires signed ${refusal.message}s. That is the ` +
    `default for a newly registered service provider: an unsigned request is ` +
    `something anyone can send, and Syntra would issue an assertion for whoever ` +
    `happened to be signed in.`;
  const extensions = {
    application: name,
    applicationId: config.applicationId,
    spEntityId: config.spEntityId,
    setting: 'wantAuthnRequestsSigned',
  };

  return refusal.kind === 'no-certificate'
    ? new ProblemError(
        409,
        'saml-no-certificate',
        'This service provider requires signed requests but has no certificate registered',
        `${shared} No signing certificate is registered for it, so there is nothing to ` +
          `verify against. Register the service provider's signing certificate, or set ` +
          `"wantAuthnRequestsSigned" to false for this application to accept unsigned requests.`,
        extensions,
      )
    : new ProblemError(
        400,
        'saml-bad-signature',
        `Invalid ${refusal.message === 'LogoutRequest' ? 'logout' : 'request'} signature`,
        `${shared} This request carried no signature that any registered certificate ` +
          `verifies. Have the service provider sign its requests, or set ` +
          `"wantAuthnRequestsSigned" to false for this application to accept unsigned requests.`,
        extensions,
      );
}

/** Reads the tenant row every SAML route needs, once. */
export async function samlContext(
  request: FastifyRequest,
  options: { publicUrl: string },
) {
  const tenant = await request.db((tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
  );
  const identity = tenantProtocolIdentity(tenant, options.publicUrl);
  assertProtocolHost(request, identity);
  return { tenant, identity };
}

export async function registerSamlIdpRoutes(
  app: FastifyInstance,
  options: SamlRouteOptions,
): Promise<void> {
  // Scoped to this plugin by Fastify's encapsulation. Registering it at the
  // root would drain the body of every `/oidc/*` request, which oidc-provider
  // reads from the raw stream itself — Task 11 depends on that, and Task 11's
  // boundary test asserts the root has no such parser.
  await app.register(formbody);

  const rateLimited = {
    // A SAML SSO endpoint evaluates policy and can mint an attempt, so it is a
    // credential-issuing endpoint whatever the URL suggests. Both dimensions,
    // exactly as portal.ts does: the per-address half alone is bounded only by
    // how many addresses the attacker has, and a second `app.rateLimit()` hook
    // would be silently inert.
    //
    // `/saml/metadata` carries it too. It is unauthenticated, it is where a
    // tenant's SAML key comes into existence on a cold tenant — RSA-2048
    // generation plus a self-signed certificate, well over a second — and even
    // warm it costs three transactions and a vault decrypt per call. Task 7
    // deliberately kept `ensureActiveKey` out of `completeSso` to keep key
    // generation off "an unauthenticated rate-limited endpoint" and then put
    // it on an unauthenticated *un*rate-limited one, because `app.ts` registers
    // `@fastify/rate-limit` with `global: false` and these two routes named no
    // limit of their own.
    config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };

  /**
   * The tenant's IdP metadata.
   *
   * Also served at `/metadata/:applicationId`, because spec section 7 asks for
   * a per-application endpoint: the document is identical for every
   * application in a tenant — one entity ID, one key set — but an
   * administrator wiring up one service provider wants a URL they can copy
   * from that application's page and hand to its vendor, and a shared URL
   * invites the question of whether it is really shared. The path parameter is
   * validated so a mistyped id is a 404 rather than a document naming an
   * application that does not exist.
   */
  const metadata = async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenant, identity } = await samlContext(request, options);
    const applicationId = (request.params as { applicationId?: string }).applicationId;
    if (applicationId !== undefined) {
      const application = await request.db((tx) => findApplication(tx, applicationId));
      if (!application || application.type !== 'saml') {
        throw new ProblemError(404, 'not-found', 'No such SAML application');
      }
    }

    // A backstop, not the seam. The tenant's SAML key is created when a
    // `SamlConfig` is written (`saveSamlConfig`), which is the moment a tenant
    // commits to being an identity provider; this call covers the tenant that
    // has configured nothing yet and whose administrator is fetching metadata
    // to hand to a vendor. Generation is expensive and must not sit inside a
    // transaction; the service opens its own.
    await ensureActiveKey(request.tenantId, localMasterKeyProvider(options.masterKey), 'saml', {
      commonName: identity.acsHost,
    });
    const keys = await publishedKeys(request.tenantId, 'saml');

    const xml = buildIdpMetadata({
      entityId: identity.entityId,
      ssoUrl: identity.ssoUrl,
      sloUrl: identity.sloUrl,
      nameIdFormats: [
        'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
      ],
      certificates: keys.flatMap((k) => (k.certificate ? [k.certificate] : [])),
    });

    void tenant;
    return reply
      .type('application/samlmetadata+xml')
      .header('cache-control', 'public, max-age=300')
      .send(xml);
  };

  app.get('/metadata', rateLimited, metadata);
  app.get('/metadata/:applicationId', rateLimited, metadata);

  /**
   * Validates an incoming AuthnRequest, parks it, and continues.
   *
   * `verify` is the binding-specific half: XML-DSig over the document for
   * HTTP-POST, a detached signature over the raw query string for
   * HTTP-Redirect (Task 8). It returns the bytes that were signed, or `''`
   * when the binding's signature does not carry the document — and null on
   * failure. Everything after `resolveAcsUrl` is identical for both bindings.
   */
  const beginSso = async (
    request: FastifyRequest,
    reply: FastifyReply,
    input: {
      xml: string;
      relayState: string | null;
      verify: (config: SamlConfigRecord) => string | null;
    },
  ) => {
    const { tenant, identity } = await samlContext(request, options);

    // Parsed only to find out who is asking. Nothing on it is acted on until
    // the signature check below, and the ACS URL is not acted on until
    // `resolveAcsUrl`.
    const unverified = readSamlInput('AuthnRequest', () => parseAuthnRequest(input.xml));

    const config = await request.db((tx) =>
      findSamlConfigByEntityId(tx, unverified.issuer),
    );
    if (!config) {
      // An unknown service provider and a disabled one read alike, so the
      // catalogue cannot be enumerated from an unauthenticated endpoint.
      throw new ProblemError(404, 'saml-unknown-sp', 'Unknown service provider');
    }

    let trusted = unverified;
    if (config.wantAuthnRequestsSigned) {
      if (config.spCertificates.length === 0) {
        throw await signedRequestRefusal(request, config, {
          kind: 'no-certificate', message: 'AuthnRequest',
        });
      }
      const verified = input.verify(config);
      if (verified === null) {
        throw await signedRequestRefusal(request, config, {
          kind: 'bad-signature', message: 'AuthnRequest',
        });
      }
      // Re-parsed from the VERIFIED bytes, never from the document that
      // arrived. That document may carry a second, forged AuthnRequest beside
      // the signed one.
      if (verified !== '') {
        trusted = readSamlInput('AuthnRequest', () => parseAuthnRequest(verified));
      }
    }

    const acsUrl = resolveAcsUrl(config, trusted.acsUrl);
    if (acsUrl === null) {
      // The request named a delivery address that is not on the allowlist.
      // Refusing rather than falling back is the whole point: a fallback would
      // post a valid signed assertion for a real user to whatever address the
      // request asked for.
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: null,
          action: 'saml.acs_refused',
          targetType: 'Application',
          targetId: config.applicationId,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: { requested: trusted.acsUrl, spEntityId: config.spEntityId },
        }),
      );
      throw new ProblemError(
        400, 'saml-acs-not-allowed',
        'That assertion consumer service URL is not registered for this application',
      );
    }

    const parked = await parkAuthnRequest(request.tenantId, {
      applicationId: config.applicationId,
      requestId: trusted.id,
      acsUrl,
      relayState: input.relayState,
      forceAuthn: trusted.forceAuthn,
      browserBinding: bindBrowser(request, reply),
    });

    return completeSso(request, reply, { tenant, identity, config, parked });
  };

  app.post('/sso', rateLimited, async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const encoded = singleValued(body, 'SAMLRequest');
    if (encoded === undefined || encoded === '') {
      throw new ProblemError(400, 'saml-bad-request', 'No SAMLRequest');
    }
    const xml = readSamlInput('SAMLRequest', () => decodePostMessage(encoded));
    return beginSso(request, reply, {
      xml,
      relayState: singleValued(body, 'RelayState') ?? null,
      verify: (config) =>
        readSamlInput('SAMLRequest', () =>
          verifyPostSignature(xml, config.spCertificates),
        ),
    });
  });

  app.get('/sso', rateLimited, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const encoded = singleValued(query, 'SAMLRequest');
    if (encoded === undefined || encoded === '') {
      throw new ProblemError(400, 'saml-bad-request', 'No SAMLRequest');
    }
    const xml = readSamlInput('SAMLRequest', () => decodeRedirectMessage(encoded));

    return beginSso(request, reply, {
      xml,
      relayState: singleValued(query, 'RelayState') ?? null,
      // The detached signature authenticates the query string, not the
      // document, so there are no verified bytes to re-parse — hence `''`
      // rather than the XML. `beginSso` keeps its already-parsed request in
      // that case, which is correct here and only here: the signature covered
      // the encoded form of exactly that document.
      verify: (config) => {
        const signature = singleValued(query, 'Signature');
        const sigAlg = singleValued(query, 'SigAlg');
        if (signature === undefined || sigAlg === undefined) return null;
        const ok = verifyRedirectSignature({
          rawQuery: signedRedirectQuery(request.raw.url ?? '', 'SAMLRequest'),
          signature,
          sigAlg,
          certificates: config.spCertificates,
        });
        return ok ? '' : null;
      },
    });
  });

  /**
   * Where the login and MFA screens return to. The handle names a parked
   * request; everything else about the flow is read off that row.
   *
   * The handle is not a credential on its own — see `SAML_BINDING_COOKIE`. It
   * is spendable only by the browser that parked it, which is what keeps this
   * URL from being a login-CSRF gadget anyone can mint for any registered
   * service provider.
   */
  app.get('/continue', rateLimited, async (request, reply) => {
    const { tenant, identity } = await samlContext(request, options);
    const handle = (request.query as Record<string, string | undefined>).handle;
    if (typeof handle !== 'string') {
      throw new ProblemError(400, 'saml-bad-request', 'No handle');
    }
    // The binding cookie, or null. A handle whose row was parked by a
    // different browser resolves to nothing here and is indistinguishable from
    // an expired one, so the response confirms nothing to whoever sent it.
    const presented = request.cookies[SAML_BINDING_COOKIE] ?? null;
    const parked = await findParkedAuthnRequest(request.tenantId, handle, presented);
    if (!parked) {
      throw new ProblemError(410, 'saml-request-expired', 'That sign-in request has expired');
    }
    const config = await request.db((tx) =>
      findSamlConfigForApplication(tx, parked.applicationId),
    );
    if (!config) throw new ProblemError(409, 'saml-not-configured', 'Not configured');
    return completeSso(request, reply, { tenant, identity, config, parked });
  });

  /**
   * Identity-provider-initiated sign-on.
   *
   * There is no AuthnRequest, so there is no InResponseTo and nothing for the
   * service provider to correlate against. That is exactly why it is off by
   * default per application (`allowIdpInitiated`): an unsolicited response is
   * an assertion the SP cannot tie to a request its own user started, which is
   * the login-CSRF shape SAML's own security considerations warn about. A
   * tenant that needs it turns it on for the applications that support it.
   *
   * The parked row is created here with `requestId: null`, so the rest of the
   * flow — assignment check, authorize(), assertion — is byte-for-byte the
   * SP-initiated path.
   */
  app.get('/start/:applicationId', rateLimited, async (request, reply) => {
    const { tenant, identity } = await samlContext(request, options);
    const { id: applicationId } = idParam.parse({ id: (request.params as { applicationId: string }).applicationId });

    const config = await request.db((tx) => findSamlConfigForApplication(tx, applicationId));
    if (!config) throw new ProblemError(404, 'saml-unknown-sp', 'Not a SAML application');
    if (!config.allowIdpInitiated) {
      throw new ProblemError(
        409, 'saml-idp-initiated-disabled',
        'This application only accepts sign-ins that start at the application itself.',
      );
    }

    const acsUrl = resolveAcsUrl(config, null);
    if (acsUrl === null) {
      throw new ProblemError(409, 'saml-no-acs', 'This application has no assertion consumer service URL');
    }

    // A single cast, narrowed through that same reference: re-casting the
    // same property access twice (once to check, once to read) defeats
    // control-flow narrowing under `noUncheckedIndexedAccess`, and the read
    // comes back typed `string | undefined`, not the narrowed `string`.
    const startQuery = request.query as Record<string, string | undefined>;
    const relayState = typeof startQuery.RelayState === 'string' ? startQuery.RelayState : null;

    const parked = await parkAuthnRequest(request.tenantId, {
      applicationId,
      requestId: null,
      acsUrl,
      relayState,
      forceAuthn: false,
      browserBinding: bindBrowser(request, reply),
    });
    return completeSso(request, reply, { tenant, identity, config, parked });
  });

  /**
   * The only place a SAML assertion is issued, and it issues one only from an
   * `allow`.
   *
   * Everything protocol-specific happened before this point; from here the
   * flow is the same decision every other entry point makes. There is no path
   * to `buildSignedResponse` that does not pass through `authorize()`, which
   * is spec section 7's requirement made structural.
   */
  async function completeSso(
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: {
      tenant: { primaryDomain: string | null };
      identity: ReturnType<typeof tenantProtocolIdentity>;
      config: SamlConfigRecord;
      parked: ParkedAuthnRequest;
    },
  ) {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await request.db((tx) => resolveSession(tx, token)) : null;

    // No Syntra session yet, or the service provider demanded a fresh
    // authentication. Send the user to the login screen; it returns here.
    if (!session || ctx.parked.forceAuthn) {
      const next = encodeURIComponent(`/saml/continue?handle=${ctx.parked.handle}`);
      return reply.redirect(`/login?next=${next}`, 302);
    }

    const assigned = await request.db((tx) =>
      isApplicationAssigned(tx, session.userId, ctx.parked.applicationId),
    );
    if (!assigned) {
      throw new ProblemError(403, 'not-assigned', 'Not available to you');
    }

    const decision = await authorize(request.tenantId, {
      kind: 'primary',
      // The session id only. `authorize()` reads the factor that established
      // the session off the row itself, so a launch that came back as a
      // challenge and was answered does not challenge again forever.
      principal: { kind: 'session', userId: session.userId, sessionId: session.sessionId },
      applicationId: ctx.parked.applicationId,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(ctx.tenant, options.publicUrl),
      // Entering an application never elevates.
      scope: 'portal',
    });

    if (decision.status === 'deny') {
      throw new ProblemError(403, 'not-assigned', 'Not available to you');
    }

    if (decision.status === 'challenge' || decision.status === 'enrol') {
      // The MFA screen answers the attempt and returns to /saml/continue,
      // where this function runs again and re-evaluates policy.
      const next = encodeURIComponent(`/saml/continue?handle=${ctx.parked.handle}`);
      const path = decision.status === 'challenge' ? '/mfa' : '/enrol';
      return reply.redirect(
        `${path}?attempt=${encodeURIComponent(decision.attemptToken)}&next=${next}`,
        302,
      );
    }

    // Spend the parked request before anything is signed. A second concurrent
    // completion loses the update and gets a 410 rather than a second
    // assertion for the same request id.
    if (!(await consumeParkedAuthnRequest(request.tenantId, ctx.parked.id))) {
      throw new ProblemError(
        410, 'saml-request-expired', 'That sign-in request has already been used',
      );
    }

    const now = new Date();
    const sessionIndex = `_${randomUUID()}`;

    const { facts, mappings } = await request.db(async (tx) => ({
      facts: await collectSubjectFacts(tx, decision.userId, now),
      mappings: await listClaimMappings(tx, ctx.parked.applicationId, 'saml'),
    }));
    const claims = resolveClaims(mappings, facts, 'saml');

    // The NameID: a mapped claim if the tenant named one, otherwise the
    // account's email. A mapped claim that resolved to nothing is a
    // configuration error the service provider cannot recover from, so it is
    // refused here rather than sent as an empty NameID.
    const nameId =
      ctx.config.nameIdClaim === null
        ? facts.user.email
        : (claims.find((c) => c.name === ctx.config.nameIdClaim)?.values[0] ?? null);
    if (!nameId) {
      throw new ProblemError(
        409, 'saml-no-name-id',
        `This application identifies users by "${ctx.config.nameIdClaim ?? 'email'}", and this account has no such value.`,
      );
    }

    // Key material is loaded outside any transaction, and signing happens
    // outside one too.
    const key = await loadActiveKey(
      request.tenantId,
      localMasterKeyProvider(options.masterKey),
      'saml',
    );
    if (!key?.certificate) {
      throw new ProblemError(409, 'saml-no-key', 'This organization has no SAML signing key yet');
    }

    const xml = buildSignedResponse(
      {
        idpEntityId: ctx.identity.entityId,
        spEntityId: ctx.config.spEntityId,
        acsUrl: ctx.parked.acsUrl,
        nameId,
        nameIdFormat: ctx.config.nameIdFormat,
        sessionIndex,
        inResponseTo: ctx.parked.requestId,
        attributes: claims.map((c) => ({
          name: c.name, nameFormat: c.nameFormat, values: c.values,
        })),
        lifetimeMs: ctx.config.assertionLifetimeMs,
        authnInstant: now,
        authnContextClassRef:
          AUTHN_CONTEXT[decision.satisfiedFactor ?? ''] ?? DEFAULT_AUTHN_CONTEXT,
        now,
      },
      { privateKeyPem: key.privateKeyPem, certificatePem: key.certificate },
    );

    // Encryption happens BEFORE anything is recorded. It can fail — 409 when
    // the application asks for encrypted assertions and has no certificate
    // registered, or a 500 out of the cipher — and with the order the other
    // way round the audit log said an assertion was issued and an SSO session
    // was open while the service provider received nothing at all. An audit
    // trail that records deliveries that did not happen is worse than one that
    // is merely incomplete, because it is the record a later investigation
    // trusts. Outside every transaction, as before: RSA plus AES over the
    // whole assertion.
    let deliverable = xml;
    if (ctx.config.encryptAssertions) {
      if (!ctx.config.encryptionCertificate) {
        throw new ProblemError(
          409, 'saml-no-encryption-certificate',
          'This application is configured to receive encrypted assertions but has no certificate registered',
        );
      }
      const assertion = xml.slice(
        xml.indexOf('<saml:Assertion'),
        xml.lastIndexOf('</saml:Assertion>') + '</saml:Assertion>'.length,
      );
      const encrypted = await encryptAssertion(assertion, ctx.config.encryptionCertificate);
      deliverable = xml.replace(assertion, encrypted);
    }

    await request.db(async (tx) => {
      await startSamlSsoSession(tx, {
        sessionId: session.sessionId,
        applicationId: ctx.parked.applicationId,
        nameId,
        sessionIndex,
      });
      await recordEvent(tx, {
        actorUserId: decision.userId,
        action: 'saml.assertion_issued',
        targetType: 'Application',
        targetId: ctx.parked.applicationId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          spEntityId: ctx.config.spEntityId,
          acsUrl: ctx.parked.acsUrl,
          inResponseTo: ctx.parked.requestId,
          satisfiedFactor: decision.satisfiedFactor,
          encrypted: ctx.config.encryptAssertions,
        },
      });
    });

    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(postBindingForm({
        acsUrl: ctx.parked.acsUrl,
        samlResponse: deliverable,
        relayState: ctx.parked.relayState,
      }));
  }

  const handleSlo = async (
    request: FastifyRequest,
    reply: FastifyReply,
    binding: 'HTTP-Redirect' | 'HTTP-POST',
  ) => {
    const { identity } = await samlContext(request, options);
    const source = (binding === 'HTTP-POST' ? request.body : request.query) as
      | Record<string, unknown>
      | undefined;

    // A LogoutResponse coming back from a service provider we notified. There
    // is nothing left to do; the session is already gone.
    if (singleValued(source, 'SAMLResponse') !== undefined) {
      return reply.redirect('/logged-out', 302);
    }

    const encoded = singleValued(source, 'SAMLRequest');
    if (encoded === undefined) {
      throw new ProblemError(400, 'saml-bad-request', 'No SAMLRequest');
    }
    // Read before anything is acted on. A duplicated parameter is a refusal,
    // and refusing after the session has already been ended would leave the
    // service provider with no LogoutResponse for a logout that happened.
    const relayState = singleValued(source, 'RelayState') ?? null;
    const xml = readSamlInput('SAMLRequest', () =>
      binding === 'HTTP-POST' ? decodePostMessage(encoded) : decodeRedirectMessage(encoded),
    );
    const unverified = readSamlInput('LogoutRequest', () => parseLogoutRequest(xml));

    const config = await request.db((tx) => findSamlConfigByEntityId(tx, unverified.issuer));
    if (!config) throw new ProblemError(404, 'saml-unknown-sp', 'Unknown service provider');

    // A logout request is destructive, so it is verified on exactly the same
    // terms as an authentication request. An SP that registered certificates
    // and asked for signed requests gets its signature checked; one that did
    // not is trusted only to end its own user's session, which is what it
    // could do by other means anyway.
    let trusted = unverified;
    if (config.wantAuthnRequestsSigned) {
      // The same explicit no-certificate refusal the sign-on path gives.
      // Without it an empty trusted set falls through to the verifiers, which
      // correctly return "no" — and the administrator reads "invalid logout
      // signature" about a request that was never going to be checked against
      // anything.
      if (config.spCertificates.length === 0) {
        throw await signedRequestRefusal(request, config, {
          kind: 'no-certificate', message: 'LogoutRequest',
        });
      }
      if (binding === 'HTTP-POST') {
        const signed = readSamlInput('LogoutRequest', () =>
          verifyPostSignature(xml, config.spCertificates),
        );
        if (signed === null) {
          throw await signedRequestRefusal(request, config, {
            kind: 'bad-signature', message: 'LogoutRequest',
          });
        }
        trusted = readSamlInput('LogoutRequest', () => parseLogoutRequest(signed));
      } else {
        const rawQuery = signedRedirectQuery(request.raw.url ?? '', 'SAMLRequest');
        const q = request.query as Record<string, unknown>;
        const signature = singleValued(q, 'Signature');
        const sigAlg = singleValued(q, 'SigAlg');
        if (
          signature === undefined || sigAlg === undefined ||
          !verifyRedirectSignature({
            rawQuery, signature, sigAlg,
            certificates: config.spCertificates,
          })
        ) {
          throw await signedRequestRefusal(request, config, {
            kind: 'bad-signature', message: 'LogoutRequest',
          });
        }
      }
    }

    // End the Syntra session and every SSO session it opened. Sessions are
    // found by the session index the assertion carried, never by the NameID
    // alone — a NameID is not a secret, and ending "every session for this
    // email address" on an unauthenticated request is a denial of service any
    // registered SP could aim at any user.
    const ended = await request.db(async (tx) => {
      const row = await tx.samlSsoSession.findFirst({
        where: {
          applicationId: config.applicationId,
          sessionIndex: trusted.sessionIndex ?? '__none__',
          endedAt: null,
        },
      });
      if (!row) return null;
      await endSsoSessions(tx, row.sessionId);
      await tx.session.updateMany({
        where: { id: row.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await recordEvent(tx, {
        actorUserId: null,
        action: 'saml.logout',
        targetType: 'Application',
        targetId: config.applicationId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: { spEntityId: config.spEntityId, sessionIndex: trusted.sessionIndex },
      });
      return row;
    });

    // Only when a session index actually matched. Firing this unconditionally
    // signs the browser out of Syntra on any unauthenticated `/saml/slo` with
    // a `SessionIndex` nobody has ever issued — the same "a NameID is not a
    // secret" denial of service the lookup above exists to prevent, reached
    // one step later through the cookie instead of the row.
    if (ended !== null) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    }

    const destination = config.sloUrl;
    if (!destination) {
      // Nowhere to answer. The session is still gone, which is the part that
      // matters.
      return reply.redirect('/logged-out', 302);
    }

    const response = buildLogoutResponse({
      idpEntityId: identity.entityId,
      destination,
      inResponseTo: trusted.id,
      success: ended !== null,
      now: new Date(),
    });

    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(
      logoutPostForm({
        destination,
        field: 'SAMLResponse',
        xml: response,
        relayState,
      }),
    );
  };

  app.get('/slo', rateLimited, (request, reply) => handleSlo(request, reply, 'HTTP-Redirect'));
  app.post('/slo', rateLimited, (request, reply) => handleSlo(request, reply, 'HTTP-POST'));
}
