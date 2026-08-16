import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import pkg from '@node-saml/node-saml';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  assignApplication,
  createApplication,
  createClaimMapping,
  createUser,
  hashPassword,
  localMasterKeyProvider,
  saveSamlConfig,
  setPasswordHash,
  upsertSamlConfig,
} from '@syntra/core';
import { signFragment } from '@syntra/protocols';
import { buildTestApp, TEST_HOST } from '../test-support.js';

const { SAML } = pkg;

export const SP = 'https://sp.example.test/metadata';
export const ACS = 'https://sp.example.test/acs';

/**
 * What `saveSamlConfig` needs to mint the tenant's SAML key at configuration
 * time. The master key is the one `buildTestApp` gives the app, so a key
 * written here is one the running app can decrypt.
 */
export const samlKeyOptions = {
  provider: localMasterKeyProvider(Buffer.alloc(32, 7)),
  commonName: TEST_HOST,
};
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
let applicationId: string;
let cookie: string;

const spKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const spPrivatePem = spKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const spPublicPem = spKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/**
 * The default configuration, so each test overrides only what it means.
 *
 * `wantAuthnRequestsSigned: false` is stated deliberately and is no longer the
 * product default (ruling A2-10). It stands for an application whose
 * administrator turned the requirement off on purpose, which is exactly the
 * posture the unsigned-request tests below are about. `samlConfigAsRegistered`
 * is the one that says nothing and inherits.
 */
export const samlConfig = (over: Record<string, unknown> = {}) => ({
  spEntityId: SP,
  acsUrls: [ACS],
  defaultAcsUrl: ACS,
  acsBinding: 'HTTP-POST' as const,
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  nameIdClaim: null,
  spCertificates: [] as string[],
  wantAuthnRequestsSigned: false,
  encryptAssertions: false,
  encryptionCertificate: null,
  sloUrl: null,
  sloBinding: 'HTTP-POST' as const,
  allowIdpInitiated: false,
  assertionLifetimeMs: 300_000,
  ...over,
});

/**
 * A configuration written the way a newly registered service provider's is:
 * nothing said about signing, so the default applies.
 *
 * The field is stripped rather than set, because "the caller said false" and
 * "the caller said nothing" are the two cases that have to be told apart, and
 * a fixture that set it explicitly could not test the second.
 */
export const samlConfigAsRegistered = (over: Record<string, unknown> = {}) => {
  const { wantAuthnRequestsSigned: _inherited, ...rest } = samlConfig(over);
  return rest;
};

export const authnRequest = (over: { id?: string; acs?: string | null } = {}) =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${over.id ?? '_req1'}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="http://${TEST_HOST}/saml/sso"${
    over.acs === null ? '' : ` AssertionConsumerServiceURL="${over.acs ?? ACS}"`
  }><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

export const extractResponse = (html: string) => {
  const match = html.match(/name="SAMLResponse" value="([^"]+)"/);
  if (!match) throw new Error('no SAMLResponse in the returned form');
  return match[1]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
};

const postSso = (
  xml: string,
  relayState?: string,
  withCookie = true,
  extraCookies: string[] = [],
) =>
  ctx.app.inject({
    method: 'POST', url: '/saml/sso',
    headers: {
      host: TEST_HOST,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: [
        ...(withCookie ? [`syntra_session=${cookie}`] : []),
        ...extraCookies,
      ].join('; '),
    },
    payload: new URLSearchParams({
      SAMLRequest: Buffer.from(xml).toString('base64'),
      ...(relayState === undefined ? {} : { RelayState: relayState }),
    }).toString(),
  });

const get = (url: string, withCookie = true, extraCookies: string[] = []) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      host: TEST_HOST,
      cookie: [
        ...(withCookie ? [`syntra_session=${cookie}`] : []),
        ...extraCookies,
      ].join('; '),
    },
  });

/**
 * The browser-binding cookie a response wrote, in `name=value` form, or none.
 *
 * `inject` returns every `Set-Cookie` on the response; this is what a second
 * request from the *same* browser would send back, and leaving it out is what
 * a request from a different browser looks like.
 */
export const bindingCookie = (res: { cookies: { name: string; value: string }[] }) => {
  const found = res.cookies.find((c) => c.name === 'syntra_saml_bind');
  return found ? [`${found.name}=${found.value}`] : [];
};

describe('SAML single sign-on over HTTP-POST', () => {
  // Scoped to this describe rather than the module's top level: this file is
  // also imported by `saml-sso-redirect.test.ts` for its shared fixtures, and
  // a top-level `beforeEach` becomes a root-level hook for whatever file
  // imports it, running before every test in that file — including the
  // Redirect suite's — and racing its own database resets against theirs.
  beforeEach(async () => {
    ctx = await buildTestApp();
    await ctx.app.ready();
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });

    ({ userId, applicationId } = await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
      const application = await createApplication(tx, {
        name: 'CRM', slug: 'crm', type: 'saml',
      });
      await assignApplication(tx, application.id, { type: 'user', id: user.id });
      await createClaimMapping(tx, application.id, {
        protocol: 'saml',
        claimName: 'department',
        nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
        sourceKind: 'contract',
        sourceField: 'department',
        contractStrategy: 'primary',
        literalValue: null,
        releaseScope: null,
        multiValued: false,
      });
      return { userId: user.id, applicationId: application.id };
    }));

    // Configuring the service provider is what creates the tenant's SAML
    // signing key — that is the whole point of `saveSamlConfig`, and there is
    // deliberately no `/saml/metadata` fetch here to make it happen. A suite
    // that fetched metadata first would prove the flow *given* a convention
    // rather than proving the convention.
    await saveSamlConfig(ctx.tenantId, applicationId, samlConfig(), samlKeyOptions);

    const login = await ctx.app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { host: TEST_HOST },
      payload: { login: 'jdoe', password: PASSWORD },
    });
    cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  });

  it('issues an assertion a real service provider validates', async () => {
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="${ACS}"`);

    const metadata = await get('/saml/metadata', false);
    const certificate = `-----BEGIN CERTIFICATE-----\n${
      metadata.body.match(/<ds:X509Certificate>([^<]+)</)![1]!
    }\n-----END CERTIFICATE-----`;

    const sp = new SAML({
      idpCert: certificate,
      issuer: SP, callbackUrl: ACS, audience: SP,
      wantAuthnResponseSigned: false, wantAssertionsSigned: true,
      validateInResponseTo: 'never' as never, acceptedClockSkewMs: 5000,
    });
    const { profile } = await sp.validatePostResponseAsync({
      SAMLResponse: extractResponse(res.body),
    });
    expect(profile!.nameID).toBe('j@acme.test');
    // The mapping resolved to no contract, so the claim is absent — not
    // present and empty.
    expect(profile!.department).toBeUndefined();
  });

  it('echoes InResponseTo and RelayState back to the service provider', async () => {
    const res = await postSso(authnRequest({ id: '_abc123' }), 'deep/link');
    expect(res.body).toContain('name="RelayState" value="deep/link"');
    const xml = Buffer.from(extractResponse(res.body), 'base64').toString('utf8');
    expect(xml).toContain('InResponseTo="_abc123"');
  });

  it('refuses an ACS URL that is not on the allowlist, issues nothing, and audits it', async () => {
    const res = await postSso(authnRequest({ acs: 'https://attacker.test/acs' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
    // Through withTenant: AuditEvent is FORCE ROW LEVEL SECURITY, so a read on
    // the bare client sees nothing whatever was written and the assertion
    // could never hold.
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'saml.acs_refused' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('refuses an ACS URL that merely starts with, or extends, an allowed one', async () => {
    for (const bad of [`${ACS}.attacker.test`, `${ACS}/`, `${ACS}/../evil`, ACS.toUpperCase()]) {
      const res = await postSso(authnRequest({ acs: bad }));
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('SAMLResponse');
    }
  });

  it('refuses when the request names no ACS URL and the application has no default', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({ defaultAcsUrl: null })),
    );
    const res = await postSso(authnRequest({ acs: null }));
    // No implicit fall back to the first registered URL — see Task 6.
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('sends an unauthenticated caller to the login screen rather than issuing anything', async () => {
    const res = await postSso(authnRequest(), undefined, false);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?next=/);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('challenges rather than issuing when policy demands a second factor', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'mfa for crm', outcome: 'require_mfa', applicationIds: [applicationId] }),
    );
    const res = await postSso(authnRequest());
    // No factor is enrolled, so the chokepoint offers enrolment. Either way it
    // is a redirect, and either way no assertion exists.
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/(mfa|enrol)\?attempt=/);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('issues nothing when policy denies', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'no crm', outcome: 'deny', applicationIds: [applicationId] }),
    );
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('issues nothing for an application the user is not assigned', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.appAssignment.findMany({ where: { applicationId } });
      await tx.appAssignment.deleteMany({ where: { id: rows[0]!.id } });
    });
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('accepts a correctly signed request and refuses one whose signed content was swapped', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );

    const sign = (xml: string) =>
      signFragment(xml, {
        privateKeyPem: spPrivatePem,
        certificatePem: spPublicPem,
        referenceXPath: "/*[local-name(.)='AuthnRequest']",
        insertAfterXPath: "/*[local-name(.)='AuthnRequest']/*[local-name(.)='Issuer']",
      });

    // The positive path first, so a verifier that rejected everything fails
    // here rather than passing the security case for the wrong reason.
    const ok = await postSso(sign(authnRequest()));
    expect(ok.statusCode).toBe(200);

    // Signature intact, payload altered: the ACS URL now points elsewhere.
    const swapped = sign(authnRequest()).replace(ACS, 'https://attacker.test/acs');
    const bad = await postSso(swapped);
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('SAMLResponse');
  });

  it('refuses an unsigned request when the application requires signed ones, and audits it', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');

    // A service provider whose signing has broken and an attacker probing
    // signatures both produced a 400 and a server log line and nothing in the
    // tamper-evident log, where `saml.acs_refused` already records the sibling
    // case. Read through withTenant: a bare `prisma` read is answered with
    // nothing under forced row-level security whether the event exists or not.
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'saml.signature_refused' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
    expect(events[0]!.payload).toMatchObject({
      reason: 'bad-signature',
      message: 'AuthnRequest',
    });
  });

  it('audits a service provider that requires signed requests with no certificate', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [], wantAuthnRequestsSigned: true,
      })),
    );
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(409);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'saml.signature_refused' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ reason: 'no-certificate' });
  });

  it('spends a parked request once, so a replayed handle issues no second assertion', async () => {
    const first = await postSso(authnRequest());
    expect(first.statusCode).toBe(200);
    const handle = await withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.samlAuthnRequest.findFirstOrThrow();
      return row.handle;
    });
    // Replayed from the SAME browser — the binding cookie the first response
    // set is sent back — so what refuses this is the spend, not the binding.
    const replay = await get(
      `/saml/continue?handle=${encodeURIComponent(handle)}`,
      true,
      bindingCookie(first),
    );
    expect(replay.statusCode).toBe(410);
    expect(replay.body).not.toContain('SAMLResponse');
  });

  it('refuses a continue handle minted in one browser and spent in another', async () => {
    // The attack. `wantAuthnRequestsSigned` defaults to false, so the attacker
    // needs nothing but the service provider's entity ID, which is public.
    // They park a request from their own browser with no session at all and
    // read the handle straight out of the 302 they are given.
    const attacker = await postSso(authnRequest(), undefined, false);
    expect(attacker.statusCode).toBe(302);
    const handle = new URL(
      decodeURIComponent(attacker.headers.location as string).replace(
        /^\/login\?next=/,
        '',
      ),
      'http://x.test',
    ).searchParams.get('handle');
    expect(handle).not.toBeNull();

    // Fed to a logged-in victim as a link. The victim's browser carries their
    // session and their own binding cookie — never the attacker's — so the
    // handle names a row that was parked by somebody else.
    const victim = await get(`/saml/continue?handle=${encodeURIComponent(handle!)}`);
    expect(victim.statusCode).toBe(410);
    expect(victim.body).not.toContain('SAMLResponse');

    // A victim who has been through single sign-on before, and so does have a
    // binding cookie of their own, is refused for the same reason rather than
    // waved through.
    const own = await postSso(authnRequest({ id: '_other' }));
    expect(own.statusCode).toBe(200);
    const withOwnBinding = await get(
      `/saml/continue?handle=${encodeURIComponent(handle!)}`,
      true,
      bindingCookie(own),
    );
    expect(withOwnBinding.statusCode).toBe(410);
    expect(withOwnBinding.body).not.toContain('SAMLResponse');

    // And the positive control: the very same handle, presented with the
    // binding the attacker's own browser was given, completes. Without this
    // the test above would pass against an implementation that had simply
    // broken `/saml/continue` for everyone.
    const sameBrowser = await get(
      `/saml/continue?handle=${encodeURIComponent(handle!)}`,
      true,
      bindingCookie(attacker),
    );
    expect(sameBrowser.statusCode).toBe(200);
    expect(sameBrowser.body).toContain('SAMLResponse');
  });

  it('keeps one binding across concurrent sign-ins in the same browser', async () => {
    // Two service-provider round trips from one browser, the second sending
    // back the cookie the first wrote. A fresh nonce per park would invalidate
    // the first tab's handle, so this is what says the binding is per browser
    // rather than per request.
    const first = await postSso(authnRequest({ id: '_one' }), undefined, false);
    expect(first.statusCode).toBe(302);
    const firstHandle = new URL(
      decodeURIComponent(first.headers.location as string).replace(/^\/login\?next=/, ''),
      'http://x.test',
    ).searchParams.get('handle')!;

    const second = await postSso(
      authnRequest({ id: '_two' }),
      undefined,
      false,
      bindingCookie(first),
    );
    expect(second.statusCode).toBe(302);

    const resumed = await get(
      `/saml/continue?handle=${encodeURIComponent(firstHandle)}`,
      true,
      bindingCookie(first),
    );
    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).toContain('SAMLResponse');
  });

  it('answers 400 rather than 500 for a malformed POST-binding message', async () => {
    // The POST binding is base64 only, never deflated, so these are the
    // shapes that reach `parseXml` and `parseAuthnRequest` directly.
    const cases: Record<string, string> = {
      'not xml': 'not xml at all',
      'wrong root element':
        '<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_x" Version="2.0"/>',
      'truncated document': authnRequest().slice(0, 120),
      'no Issuer': authnRequest().replace(
        `<saml:Issuer>${SP}</saml:Issuer>`, '',
      ),
    };
    for (const [name, xml] of Object.entries(cases)) {
      const res = await postSso(xml);
      expect(res.statusCode, name).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).not.toContain('SAMLResponse');
    }
  });

  it('refuses a duplicated SAMLRequest rather than picking one', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/saml/sso',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `syntra_session=${cookie}`,
      },
      // Two requests, one of which names an ACS URL that is not on the
      // allowlist. Whichever the parser happens to pick, the answer is that
      // nobody legitimate sends this.
      payload:
        `SAMLRequest=${encodeURIComponent(Buffer.from(authnRequest()).toString('base64'))}` +
        `&SAMLRequest=${encodeURIComponent(
          Buffer.from(authnRequest({ acs: 'https://attacker.test/acs' })).toString('base64'),
        )}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('refuses when the request arrives on a sibling of the tenant host', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/saml/sso',
      headers: {
        host: `${TEST_HOST}.attacker.example`,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `syntra_session=${cookie}`,
      },
      payload: new URLSearchParams({
        SAMLRequest: Buffer.from(authnRequest()).toString('base64'),
      }).toString(),
    });
    expect(res.statusCode).toBe(421);
  });
});
