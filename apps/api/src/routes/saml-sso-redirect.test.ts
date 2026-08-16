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
  saveSamlConfig,
  setPasswordHash,
  upsertSamlConfig,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';
import {
  ACS, SP, authnRequest, extractResponse, samlConfig, samlConfigAsRegistered,
  samlKeyOptions, spPrivatePem, spPublicPem,
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
      return application.id;
    });

    // Configuring the service provider is what creates the tenant's SAML
    // signing key. No `/saml/metadata` fetch here on purpose: the convention
    // this suite used to depend on is now the thing under test.
    await saveSamlConfig(ctx.tenantId, applicationId, samlConfig(), samlKeyOptions);

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
    // 400, not `>= 400`. The loose assertion this replaces was satisfied by
    // the 500 that the endpoint actually returned — a test sitting beside the
    // defect it was written to catch, passing.
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('answers 400 rather than 500 for every shape of malformed message', async () => {
    // Every one of these is unauthenticated input that a stranger can send.
    // `parseXml`, `parseAuthnRequest` and the decoders all throw a plain
    // `Error`, which `problem-json.ts` maps to a bare 500 — correctly, since
    // an unrecognised throw is a bug. None of these is a bug: they all mean
    // "your message is not a SAML message", and a 500 both misleads the sender
    // and buries a real fault in noise if this ever gets alerted on.
    const cases: Record<string, string> = {
      // Base64 of valid XML that was never deflated.
      undeflated: Buffer.from(authnRequest()).toString('base64'),
      'deflated garbage': encode('not xml at all'),
      'wrong root element': encode(
        '<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"' +
          ' ID="_x" Version="2.0"/>',
      ),
      'truncated document': encode(authnRequest().slice(0, 120)),
      'no ID attribute': encode(authnRequest().replace(' ID="_req1"', '')),
      'not base64 at all': '!!!!!',
    };

    for (const [name, param] of Object.entries(cases)) {
      const res = await get(`/saml/sso?SAMLRequest=${encodeURIComponent(param)}`);
      expect(res.statusCode, name).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).not.toContain('SAMLResponse');
    }
  });

  it('refuses a duplicated RelayState rather than signing one and acting on another', async () => {
    await saveSamlConfig(
      ctx.tenantId, applicationId,
      samlConfig({ spCertificates: [spPublicPem], wantAuthnRequestsSigned: true }),
      samlKeyOptions,
    );
    const request = encodeURIComponent(encode(authnRequest()));
    // `signedRedirectQuery` lifts the FIRST occurrence into the signed string,
    // so the signature checks out over `deep/link` — and `request.query
    // .RelayState` is an array, which the old `typeof` guard turned into null.
    // The signature covered something other than the value acted on.
    const signed = `SAMLRequest=${request}&RelayState=${encodeURIComponent('deep/link')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const res = await get(
      `/saml/sso?SAMLRequest=${request}&RelayState=${encodeURIComponent('deep/link')}` +
        `&RelayState=${encodeURIComponent('https://attacker.test')}` +
        `&SigAlg=${encodeURIComponent(SIG_ALG)}&Signature=${encodeURIComponent(sign(signed))}`,
    );
    expect(res.statusCode).toBe(400);
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

  it('refuses an attacker-crafted unsigned request that a logged-in victim follows', async () => {
    // The one-request path. There is no handle and no second visit, so the
    // browser binding on the parked row cannot reach it: an attacker composes
    // an AuthnRequest of their own, sends a logged-in victim a plain link to
    // `/saml/sso?SAMLRequest=…`, and parking and completion both happen inside
    // that single navigation — with the victim's own session and the victim's
    // own binding cookie. Before ruling A2-10 this issued an assertion for the
    // victim and auto-posted it to the service provider's real ACS, bounded
    // only by whether that service provider validates `InResponseTo`.
    //
    // Registered the way a new service provider is: nothing said about
    // signing.
    await saveSamlConfig(
      ctx.tenantId, applicationId, samlConfigAsRegistered(), samlKeyOptions,
    );

    const victim = await get(redirectUrl(authnRequest()));
    expect(victim.statusCode).toBe(409);
    expect(victim.body).not.toContain('SAMLResponse');

    // And the refusal is actionable without reading a Prisma model.
    const problem = JSON.parse(victim.body);
    expect(problem.setting).toBe('wantAuthnRequestsSigned');
    expect(problem.application).toBe('CRM');
    expect(problem.detail).toContain('wantAuthnRequestsSigned');
    expect(problem.detail).toContain('CRM');
  });

  it('still refuses the one-request path once a certificate is registered but the request is unsigned', async () => {
    // The properly configured case: the service provider's certificate is on
    // file, so there *is* something to verify against, and the attacker does
    // not hold the key. This is the state a working integration is in, and it
    // is the state the ruling actually protects.
    await saveSamlConfig(
      ctx.tenantId, applicationId,
      samlConfigAsRegistered({ spCertificates: [spPublicPem] }),
      samlKeyOptions,
    );

    const victim = await get(redirectUrl(authnRequest()));
    expect(victim.statusCode).toBe(400);
    expect(victim.body).not.toContain('SAMLResponse');
    expect(JSON.parse(victim.body).setting).toBe('wantAuthnRequestsSigned');

    // Positive control: the service provider's own signed request, over the
    // same one-request path, still completes. Without this the test above
    // would pass against an implementation that had simply broken /saml/sso.
    const signedQuery = `SAMLRequest=${encodeURIComponent(encode(authnRequest()))}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const genuine = await get(
      `/saml/sso?${signedQuery}&Signature=${encodeURIComponent(sign(signedQuery))}`,
    );
    expect(genuine.statusCode).toBe(200);
    expect(genuine.body).toContain('SAMLResponse');
  });

  it('lets an administrator opt an application out deliberately', async () => {
    // False is still a posture a tenant may choose per application — it is now
    // something they chose rather than something they inherited. If this
    // failed, the ruling would have become "signed requests always", which is
    // not what was decided.
    await saveSamlConfig(
      ctx.tenantId, applicationId,
      samlConfig({ wantAuthnRequestsSigned: false }),
      samlKeyOptions,
    );
    const res = await get(redirectUrl(authnRequest()));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SAMLResponse');
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
