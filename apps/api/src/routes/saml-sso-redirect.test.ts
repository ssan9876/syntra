import { beforeEach, describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { createSign } from 'node:crypto';
import pkg from '@node-saml/node-saml';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  assignApplication,
  createApplication,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertSamlConfig,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';
import {
  ACS, SP, authnRequest, extractResponse, samlConfig, spPrivatePem, spPublicPem,
} from './saml-sso-post.test.js';

const { SAML } = pkg;
const SIG_ALG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let applicationId: string;
let cookie: string;

const encode = (xml: string) => deflateRawSync(Buffer.from(xml)).toString('base64');
const sign = (rawQuery: string) =>
  createSign('RSA-SHA256').update(rawQuery).sign(spPrivatePem).toString('base64');

const get = (url: string, withCookie = true) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      host: TEST_HOST,
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
  });

const redirectUrl = (xml: string, relayState?: string) =>
  `/saml/sso?SAMLRequest=${encodeURIComponent(encode(xml))}` +
  (relayState === undefined ? '' : `&RelayState=${encodeURIComponent(relayState)}`);

describe('SAML single sign-on over HTTP-Redirect', () => {
  // Scoped to this describe, not the module top level: `beforeEach` at module
  // scope becomes a root-level hook for whichever file runs it, and this file
  // shares a process with `saml-sso-post.test.ts`'s own suite by importing it
  // for fixtures. An unscoped hook here would run before every test in that
  // suite too and race its database reset against this one's.
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

    // The tenant's SAML signing key comes into existence when its metadata is
    // first fetched, and `completeSso` only ever reads a key — it never
    // creates one. Without this, every test below would fail with 409
    // `saml-no-key` rather than exercising the Redirect binding at all.
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
    const res = await get(redirectUrl(authnRequest()));
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
  });

  it('answers a redirect-binding request with a POST-binding response', async () => {
    // The binding of the request does not decide the binding of the response;
    // the ACS entry does, and a Response is far too large for a URL.
    const res = await get(redirectUrl(authnRequest()));
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('method="post"');
  });

  it('refuses an ACS URL that is not on the allowlist and issues nothing', async () => {
    const res = await get(redirectUrl(authnRequest({ acs: 'https://attacker.test/acs' })));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('refuses a decompression bomb', async () => {
    const bomb = deflateRawSync(Buffer.alloc(30 * 1024 * 1024, 0x20)).toString('base64');
    const res = await get(`/saml/sso?SAMLRequest=${encodeURIComponent(bomb)}`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('accepts a correctly signed request and refuses the same signature over a different one', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );

    const good = encode(authnRequest());
    const signedQuery = `SAMLRequest=${encodeURIComponent(good)}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const signature = sign(signedQuery);

    // Positive path first, so a verifier that rejects everything fails here.
    const ok = await get(`/saml/sso?${signedQuery}&Signature=${encodeURIComponent(signature)}`);
    expect(ok.statusCode).toBe(200);

    // The attack: same signature, different request, attacker's ACS URL.
    const swapped = encode(authnRequest({ acs: 'https://attacker.test/acs' }));
    const bad = await get(
      `/saml/sso?SAMLRequest=${encodeURIComponent(swapped)}&SigAlg=${encodeURIComponent(SIG_ALG)}&Signature=${encodeURIComponent(signature)}`,
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('SAMLResponse');
  });

  it('includes RelayState in the signed bytes only when it was sent', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );
    const request = encodeURIComponent(encode(authnRequest()));
    const withRelay = `SAMLRequest=${request}&RelayState=${encodeURIComponent('deep/link')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;

    const ok = await get(`/saml/sso?${withRelay}&Signature=${encodeURIComponent(sign(withRelay))}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('name="RelayState" value="deep/link"');

    // A signature computed WITHOUT the relay state must not authenticate a
    // request that carries one — that is how an attacker injects a landing
    // page into somebody else's signed sign-in.
    const withoutRelay = `SAMLRequest=${request}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const mismatched = await get(
      `/saml/sso?SAMLRequest=${request}&RelayState=${encodeURIComponent('https://attacker.test')}&SigAlg=${encodeURIComponent(SIG_ALG)}&Signature=${encodeURIComponent(sign(withoutRelay))}`,
    );
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.body).not.toContain('SAMLResponse');
  });

  it('refuses a signed-request application when no Signature is present at all', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );
    const res = await get(redirectUrl(authnRequest()));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('challenges rather than issuing when policy demands a second factor', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'mfa for crm', outcome: 'require_mfa', applicationIds: [applicationId] }),
    );
    const res = await get(redirectUrl(authnRequest()));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/(mfa|enrol)\?attempt=/);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('issues nothing when policy denies', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'no crm', outcome: 'deny', applicationIds: [applicationId] }),
    );
    const res = await get(redirectUrl(authnRequest()));
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('refuses when the request arrives on a sibling of the tenant host', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: redirectUrl(authnRequest()),
      headers: {
        host: `${TEST_HOST}.attacker.example`,
        cookie: `syntra_session=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(421);
  });
});
