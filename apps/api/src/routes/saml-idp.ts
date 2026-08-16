import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import {
  authorize,
  collectSubjectFacts,
  consumeParkedAuthnRequest,
  ensureActiveKey,
  findApplication,
  findParkedAuthnRequest,
  findSamlConfigByEntityId,
  findSamlConfigForApplication,
  isApplicationAssigned,
  listClaimMappings,
  loadActiveKey,
  localMasterKeyProvider,
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
  buildSignedResponse,
  decodePostMessage,
  decodeRedirectMessage,
  parseAuthnRequest,
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

    // Generation is expensive and must not sit inside a transaction; the
    // service opens its own. Fetching metadata is the first thing an
    // administrator does when wiring an SP, so this is where the tenant's
    // SAML key comes into existence.
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

  app.get('/metadata', metadata);
  app.get('/metadata/:applicationId', metadata);

  const rateLimited = {
    // A SAML SSO endpoint evaluates policy and can mint an attempt, so it is a
    // credential-issuing endpoint whatever the URL suggests. Both dimensions,
    // exactly as portal.ts does: the per-address half alone is bounded only by
    // how many addresses the attacker has, and a second `app.rateLimit()` hook
    // would be silently inert.
    config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };

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
    const unverified = parseAuthnRequest(input.xml);

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
        throw new ProblemError(
          409, 'saml-no-certificate',
          'This service provider requires signed requests but has no certificate registered',
        );
      }
      const verified = input.verify(config);
      if (verified === null) {
        throw new ProblemError(400, 'saml-bad-signature', 'Invalid request signature');
      }
      // Re-parsed from the VERIFIED bytes, never from the document that
      // arrived. That document may carry a second, forged AuthnRequest beside
      // the signed one.
      if (verified !== '') trusted = parseAuthnRequest(verified);
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
    });

    return completeSso(request, reply, { tenant, identity, config, parked });
  };

  app.post('/sso', rateLimited, async (request, reply) => {
    const body = request.body as Record<string, string | undefined> | undefined;
    const encoded = body?.SAMLRequest;
    if (typeof encoded !== 'string' || encoded === '') {
      throw new ProblemError(400, 'saml-bad-request', 'No SAMLRequest');
    }
    const xml = decodePostMessage(encoded);
    return beginSso(request, reply, {
      xml,
      relayState: typeof body?.RelayState === 'string' ? body.RelayState : null,
      verify: (config) => verifyPostSignature(xml, config.spCertificates),
    });
  });

  app.get('/sso', rateLimited, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const encoded = query.SAMLRequest;
    if (typeof encoded !== 'string' || encoded === '') {
      throw new ProblemError(400, 'saml-bad-request', 'No SAMLRequest');
    }
    const xml = decodeRedirectMessage(encoded);

    return beginSso(request, reply, {
      xml,
      relayState: typeof query.RelayState === 'string' ? query.RelayState : null,
      // The detached signature authenticates the query string, not the
      // document, so there are no verified bytes to re-parse — hence `''`
      // rather than the XML. `beginSso` keeps its already-parsed request in
      // that case, which is correct here and only here: the signature covered
      // the encoded form of exactly that document.
      verify: (config) => {
        const signature = query.Signature;
        const sigAlg = query.SigAlg;
        if (typeof signature !== 'string' || typeof sigAlg !== 'string') return null;
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
   */
  app.get('/continue', rateLimited, async (request, reply) => {
    const { tenant, identity } = await samlContext(request, options);
    const handle = (request.query as Record<string, string | undefined>).handle;
    if (typeof handle !== 'string') {
      throw new ProblemError(400, 'saml-bad-request', 'No handle');
    }
    const parked = await findParkedAuthnRequest(request.tenantId, handle);
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
        },
      });
    });

    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(postBindingForm({
        acsUrl: ctx.parked.acsUrl,
        samlResponse: xml,
        relayState: ctx.parked.relayState,
      }));
  }
}
