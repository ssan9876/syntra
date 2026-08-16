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
  setPasswordHash,
  upsertSamlConfig,
} from '@syntra/core';
import { signFragment } from '@syntra/protocols';
import { buildTestApp, TEST_HOST } from '../test-support.js';

const { SAML } = pkg;

export const SP = 'https://sp.example.test/metadata';
export const ACS = 'https://sp.example.test/acs';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
let applicationId: string;
let cookie: string;

const spKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const spPrivatePem = spKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const spPublicPem = spKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** The default configuration, so each test overrides only what it means. */
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

export const authnRequest = (over: { id?: string; acs?: string | null } = {}) =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${over.id ?? '_req1'}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="http://${TEST_HOST}/saml/sso"${
    over.acs === null ? '' : ` AssertionConsumerServiceURL="${over.acs ?? ACS}"`
  }><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

export const extractResponse = (html: string) => {
  const match = html.match(/name="SAMLResponse" value="([^"]+)"/);
  if (!match) throw new Error('no SAMLResponse in the returned form');
  return match[1]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
};

const postSso = (xml: string, relayState?: string, withCookie = true) =>
  ctx.app.inject({
    method: 'POST', url: '/saml/sso',
    headers: {
      host: TEST_HOST,
      'content-type': 'application/x-www-form-urlencoded',
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
    payload: new URLSearchParams({
      SAMLRequest: Buffer.from(xml).toString('base64'),
      ...(relayState === undefined ? {} : { RelayState: relayState }),
    }).toString(),
  });

const get = (url: string, withCookie = true) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      host: TEST_HOST,
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
  });

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
      await upsertSamlConfig(tx, application.id, samlConfig());
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

    // The tenant's SAML signing key comes into existence when its metadata is
    // first fetched — which is how an administrator wires up a service provider
    // in the first place, since the SP needs the certificate before it can send
    // anything. Without that, `completeSso` correctly refuses with 409
    // `saml-no-key`, which is a real behaviour and not what these tests are
    // about. Done once here rather than per test.
    await ctx.app.inject({
      method: 'GET', url: '/saml/metadata', headers: { host: TEST_HOST },
    });

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

  it('refuses an unsigned request when the application requires signed ones', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('spends a parked request once, so a replayed handle issues no second assertion', async () => {
    const first = await postSso(authnRequest());
    expect(first.statusCode).toBe(200);
    const handle = await withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.samlAuthnRequest.findFirstOrThrow();
      return row.handle;
    });
    const replay = await get(`/saml/continue?handle=${encodeURIComponent(handle)}`);
    expect(replay.statusCode).toBe(410);
    expect(replay.body).not.toContain('SAMLResponse');
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
