import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { randomUUID, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { prisma, withTenant } from '@syntra/db';
import {
  assignApplication,
  createApplication,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertSamlConfig,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';
import {
  ACS, SP, authnRequest, extractResponse, samlConfig,
} from './saml-sso-post.test.js';

// See packages/protocols/src/saml/saml-logout.test.ts: `xpath`'s type
// declarations force-include the DOM lib wherever they end up in the
// compilation, which apps/api's program picks up transitively through
// `@syntra/protocols`'s source. That makes the ambient `Crypto` type here a
// different shape than `node:crypto`'s `webcrypto.Crypto`; `as unknown as
// never` is this codebase's established escape hatch for that.
x509.cryptoProvider.set(webcrypto as unknown as never);

const CERT_ALG = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

/**
 * `xml-encryption`'s `pem` option must be an actual X.509 certificate — its
 * `pemToCert` regexes for `-----BEGIN CERTIFICATE-----` and throws a bare
 * `TypeError` on a plain SPKI public key PEM, which is what
 * `generateKeyPairSync('rsa', ...).publicKey.export(...)` produces (the
 * brief's own fixture). This mints a real self-signed certificate over an RSA
 * key pair, the same way `signing-key-service.ts` mints the tenant's own SAML
 * certificate, so the fixture matches what `encryptAssertion` actually
 * receives from `ctx.config.encryptionCertificate` in production.
 */
async function generateEncryptionCert(): Promise<{ certificatePem: string }> {
  const keys = (await webcrypto.subtle.generateKey(CERT_ALG, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomUUID().replace(/-/g, ''),
    name: 'CN=sp.example.test',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    signingAlgorithm: CERT_ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });
  return { certificatePem: cert.toString('pem') };
}

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let applicationId: string;
let cookie: string;

const get = (url: string, withCookie = true) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      host: TEST_HOST,
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
  });

const redirectUrl = (xml: string) =>
  `/saml/sso?SAMLRequest=${encodeURIComponent(deflateRawSync(Buffer.from(xml)).toString('base64'))}`;

describe('SAML single logout', () => {
  // Scoped to this describe, not module top level — a top-level `beforeEach`
  // becomes a root-level hook for whatever file imports this one for shared
  // fixtures, racing its database reset against another suite's. Same
  // reasoning as saml-sso-redirect.test.ts; this file imports
  // saml-sso-post.test.ts for `ACS`/`SP`/`authnRequest`/`samlConfig`/
  // `extractResponse` but reproduces its `beforeEach` verbatim rather than
  // sharing it, since it closes over that file's module-level state.
  beforeEach(async () => {
    ctx = await buildTestApp();
    await ctx.app.ready();
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });

    applicationId = await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
      const application = await createApplication(tx, {
        name: 'CRM', slug: 'crm', type: 'saml',
      });
      await assignApplication(tx, application.id, { type: 'user', id: user.id });
      await upsertSamlConfig(tx, application.id, samlConfig());
      return application.id;
    });

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

  it('ends the Syntra session named by the session index, and answers the service provider', async () => {
    const sso = await get(redirectUrl(authnRequest()));
    expect(sso.statusCode).toBe(200);

    const { sessionIndex, sessionId } = await withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.samlSsoSession.findFirstOrThrow();
      return { sessionIndex: row.sessionIndex, sessionId: row.sessionId };
    });

    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, {
        spEntityId: SP, acsUrls: [ACS], defaultAcsUrl: ACS, acsBinding: 'HTTP-POST',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        nameIdClaim: null, spCertificates: [], wantAuthnRequestsSigned: false,
        encryptAssertions: false, encryptionCertificate: null,
        sloUrl: 'https://sp.example.test/slo', sloBinding: 'HTTP-POST',
        allowIdpInitiated: false, assertionLifetimeMs: 300_000,
      }),
    );

    const logoutXml = `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr1" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${SP}</saml:Issuer><saml:NameID>j@acme.test</saml:NameID><samlp:SessionIndex>${sessionIndex}</samlp:SessionIndex></samlp:LogoutRequest>`;

    const res = await get(
      `/saml/slo?SAMLRequest=${encodeURIComponent(deflateRawSync(Buffer.from(logoutXml)).toString('base64'))}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="SAMLResponse"');
    expect(res.body).toContain('action="https://sp.example.test/slo"');

    // Through withTenant: Session is FORCE ROW LEVEL SECURITY, so a read on
    // the bare client sees nothing whatever was written and the assertion
    // could never hold. (This is the sixth instance on this branch of a
    // brief test reading a tenant-scoped table through the bare `prisma`
    // client — see the task report.)
    const row = await withTenant(ctx.tenantId, (tx) =>
      tx.session.findUniqueOrThrow({ where: { id: sessionId } }),
    );
    expect(row.revokedAt).not.toBeNull();

    // And the session really is unusable, not merely marked.
    const after = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('does not end a session when the session index does not match', async () => {
    await get(redirectUrl(authnRequest()));
    const logoutXml = `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr1" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${SP}</saml:Issuer><saml:NameID>j@acme.test</saml:NameID><samlp:SessionIndex>_not_a_real_index</samlp:SessionIndex></samlp:LogoutRequest>`;
    await get(
      `/saml/slo?SAMLRequest=${encodeURIComponent(deflateRawSync(Buffer.from(logoutXml)).toString('base64'))}`,
    );
    // A NameID is not a secret. Ending every session for an email address on
    // an unauthenticated request would let any registered SP sign any user
    // out of everything.
    const still = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(still.statusCode).toBe(200);
  });

  it('refuses identity-provider-initiated sign-on unless the application allows it', async () => {
    const off = await get(`/saml/start/${applicationId}`);
    expect(off.statusCode).toBe(409);
    expect(off.body).not.toContain('SAMLResponse');

    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, {
        spEntityId: SP, acsUrls: [ACS], defaultAcsUrl: ACS, acsBinding: 'HTTP-POST',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        nameIdClaim: null, spCertificates: [], wantAuthnRequestsSigned: false,
        encryptAssertions: false, encryptionCertificate: null, sloUrl: null,
        sloBinding: 'HTTP-POST', allowIdpInitiated: true, assertionLifetimeMs: 300_000,
      }),
    );

    const on = await get(`/saml/start/${applicationId}`);
    expect(on.statusCode).toBe(200);
    const xml = Buffer.from(extractResponse(on.body), 'base64').toString('utf8');
    // Unsolicited: no InResponseTo anywhere in the document.
    expect(xml).not.toContain('InResponseTo');
  });

  it('delivers an encrypted assertion when the application asks for one', async () => {
    const { certificatePem } = await generateEncryptionCert();
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, {
        spEntityId: SP, acsUrls: [ACS], defaultAcsUrl: ACS, acsBinding: 'HTTP-POST',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        nameIdClaim: null, spCertificates: [], wantAuthnRequestsSigned: false,
        encryptAssertions: true,
        encryptionCertificate: certificatePem,
        sloUrl: null, sloBinding: 'HTTP-POST', allowIdpInitiated: false,
        assertionLifetimeMs: 300_000,
      }),
    );
    const res = await get(redirectUrl(authnRequest()));
    const xml = Buffer.from(extractResponse(res.body), 'base64').toString('utf8');
    expect(xml).toContain('EncryptedAssertion');
    // The subject must not be readable in the delivered document.
    expect(xml).not.toContain('j@acme.test');
  });
});
