import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { generateKeyPairSync } from 'node:crypto';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  deactivateUser,
  localMasterKeyProvider,
  upsertUpstream,
  type UpstreamInput,
} from '@syntra/core';
import { parseXml, signFragment } from '@syntra/protocols';
import { buildTestApp, TEST_HOST } from '../test-support.js';

const IDP = 'https://idp.example.test/metadata';
const SSO = 'https://idp.example.test/sso';
const SP = `http://${TEST_HOST}/federation/saml/metadata`;
const ACS = `http://${TEST_HOST}/federation/saml/acs`;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const certificatePem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A key the upstream has never published. Nothing it signs is evidence. */
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
const roguePrivateKeyPem = rogue.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rogueCertificatePem = rogue.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const keyProvider = localMasterKeyProvider(Buffer.alloc(32, 7));

const upstreamFixture = (over: Partial<UpstreamInput> = {}): UpstreamInput => ({
  slug: 'adfs',
  name: 'Contoso ADFS',
  protocol: 'saml',
  enabled: true,
  issuerUrl: null,
  clientId: null,
  scopes: [],
  idpEntityId: IDP,
  ssoUrl: SSO,
  idpSloUrl: null,
  ssoBinding: 'HTTP-Redirect',
  idpCertificates: [certificatePem],
  wantAssertionsSigned: true,
  loginAttribute: 'mail',
  emailAttribute: 'mail',
  displayNameAttribute: 'displayName',
  groupsAttribute: 'groups',
  createUsers: true,
  refreshOnLogin: true,
  defaultOrgUnitId: null,
  ...over,
});

/**
 * Sets a tenant up to federate: one SAML upstream, one `federate` routing rule.
 *
 * Through `withTenant` and through `addRule`, never a bare `prisma.*.create` —
 * every table below is FORCE ROW LEVEL SECURITY, so a fixture written the
 * other way writes nothing and the test that follows proves nothing.
 */
const setUpFederation = async (tenantId: string, over: Partial<UpstreamInput> = {}) =>
  withTenant(tenantId, async (tx) => {
    const upstream = await upsertUpstream(tx, keyProvider, upstreamFixture(over));
    await addRule(tx, {
      name: 'adfs for acme',
      outcome: 'federate',
      upstreamIdpId: upstream.id,
      loginDomains: ['acme.test'],
    });
    return upstream;
  });

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Forgery {
  subject?: string;
  audience?: string;
  issuer?: string;
  recipient?: string;
  /** `null` omits the attribute, the way an unsolicited assertion does. */
  inResponseTo?: string | null;
  now?: Date;
  sign?: boolean;
  rogueKey?: boolean;
  wrap?: (signedAssertion: string) => string;
  /** What the unsigned envelope claims, which nothing may read. */
  envelopeInResponseTo?: string;
}

/**
 * Builds and signs an assertion the way the upstream would.
 *
 * Local rather than a stub HTTP server: a SAML SP receives the assertion
 * through the browser, so there is no upstream connection to stub. The signing
 * key is the one the fixture registered, which is what makes `rogueKey` a
 * genuine forgery rather than a malformed document.
 */
const upstreamResponse = (requestId: string, over: Forgery = {}) => {
  const now = over.now ?? new Date();
  const inResponseTo = over.inResponseTo === undefined ? requestId : over.inResponseTo;
  const echo = inResponseTo === null ? '' : ` InResponseTo="${inResponseTo}"`;
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${over.issuer ?? IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${over.subject ?? 'jdoe@acme.test'}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(new Date(now.getTime() + 300000))}" Recipient="${over.recipient ?? ACS}"${echo}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60000))}" NotOnOrAfter="${iso(new Date(now.getTime() + 300000))}">` +
    `<saml:AudienceRestriction><saml:Audience>${over.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_si1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="mail"><saml:AttributeValue>${over.subject ?? 'jdoe@acme.test'}</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="displayName"><saml:AttributeValue>J Doe</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="groups"><saml:AttributeValue>Finance</saml:AttributeValue><saml:AttributeValue>Domain Admins</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion>`;

  const signed =
    over.sign === false
      ? assertion
      : signFragment(assertion, {
          privateKeyPem: over.rogueKey ? roguePrivateKeyPem : privateKeyPem,
          certificatePem: over.rogueKey ? rogueCertificatePem : certificatePem,
          referenceXPath: "/*[local-name(.)='Assertion']",
          insertAfterXPath: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
        });

  const body = over.wrap ? over.wrap(signed) : signed;
  const envelopeEcho = over.envelopeInResponseTo
    ? ` InResponseTo="${over.envelopeInResponseTo}"`
    : '';

  return Buffer.from(
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1" Version="2.0" IssueInstant="${iso(now)}" Destination="${ACS}"${envelopeEcho}>` +
      `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${body}</samlp:Response>`,
  ).toString('base64');
};

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });
  await setUpFederation(ctx.tenantId);
});

afterEach(async () => {
  await ctx.app.close();
});

const get = (url: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: TEST_HOST } });

const post = (payload: Record<string, string>) =>
  ctx.app.inject({
    method: 'POST',
    url: '/federation/saml/acs',
    headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  });

/** Starts a login and reads back what actually went to the upstream. */
const start = async (login = 'jdoe@acme.test', next?: string) => {
  const url = `/federation/start?login=${encodeURIComponent(login)}${
    next ? `&next=${encodeURIComponent(next)}` : ''
  }`;
  const res = await get(url);
  if (res.statusCode !== 302) return { res, relayState: null, requestId: null };
  const redirect = new URL(res.headers.location as string);
  const xml = inflateRawSync(
    Buffer.from(redirect.searchParams.get('SAMLRequest')!, 'base64'),
  ).toString('utf8');
  return {
    res,
    redirect,
    relayState: redirect.searchParams.get('RelayState')!,
    requestId: parseXml(xml).documentElement!.getAttribute('ID')!,
  };
};

/** The whole round trip, standing in for the upstream's POST back. */
const federate = async (over: Forgery = {}, login = 'jdoe@acme.test') => {
  const { relayState, requestId } = await start(login);
  return post({
    SAMLResponse: upstreamResponse(requestId!, over),
    RelayState: relayState!,
  });
};

const usersOf = (tenantId: string) => withTenant(tenantId, (tx) => tx.user.findMany());
const eventsOf = (tenantId: string, action: string) =>
  withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { action } }));
const hasSession = (cookies: { name: string }[]) =>
  cookies.some((c) => c.name === 'syntra_session');

describe('upstream SAML federation', () => {
  it('signs a user in from a signed upstream assertion', async () => {
    const res = await federate();
    expect(res.statusCode).toBe(302);
    expect(hasSession(res.cookies)).toBe(true);

    const users = await usersOf(ctx.tenantId);
    expect(users).toHaveLength(1);
    expect(users[0]!.login).toBe('jdoe@acme.test');
    expect(users[0]!.displayName).toBe('J Doe');
    expect(users[0]!.passwordSource).toBe('upstream');

    // The decision is in the audit log, naming who vouched — and the issuer it
    // names is the one the *signature* covered.
    const events = await eventsOf(ctx.tenantId, 'auth.login');
    expect(events.some((e) => JSON.stringify(e.payload).includes('external'))).toBe(true);
    expect(events.some((e) => JSON.stringify(e.payload).includes(IDP))).toBe(true);

    // The upstream asserted `Domain Admins`. It is recorded and it grants
    // nothing: an upstream group is not a Syntra authorization.
    const provisioned = await eventsOf(ctx.tenantId, 'federation.user_provisioned');
    expect(provisioned[0]!.payload).toMatchObject({
      assertedGroups: ['Finance', 'Domain Admins'],
    });
    const memberships = await withTenant(ctx.tenantId, (tx) =>
      tx.groupMembership.findMany(),
    );
    expect(memberships).toHaveLength(0);
  });

  it('refreshes the same user on the second login rather than creating another', async () => {
    await federate();
    await federate();
    expect(await usersOf(ctx.tenantId)).toHaveLength(1);
  });

  it('stores the AuthnRequest ID it sent, and sends the tenant its own ACS URL', async () => {
    const { redirect, relayState, requestId } = await start();
    expect(redirect!.origin + redirect!.pathname).toBe(SSO);

    const row = await withTenant(ctx.tenantId, (tx) =>
      tx.federationRequest.findFirstOrThrow(),
    );
    expect(row.state).toBe(relayState);
    // Without this the response can be bound to nothing.
    expect(row.nonce).toBe(requestId);

    const xml = inflateRawSync(
      Buffer.from(redirect!.searchParams.get('SAMLRequest')!, 'base64'),
    ).toString('utf8');
    const doc = parseXml(xml);
    // Built from the tenant's identity, never from the Host header.
    expect(doc.documentElement!.getAttribute('AssertionConsumerServiceURL')).toBe(ACS);
  });

  it('refuses an unsolicited assertion with no matching relay state', async () => {
    const { requestId } = await start();
    const res = await post({
      SAMLResponse: upstreamResponse(requestId!),
      RelayState: 'never-issued',
    });
    expect(res.statusCode).toBe(400);
    expect(hasSession(res.cookies)).toBe(false);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);
  });

  it('refuses a replayed assertion even with the relay state it was issued for', async () => {
    const { relayState, requestId } = await start();
    const payload = {
      SAMLResponse: upstreamResponse(requestId!),
      RelayState: relayState!,
    };
    expect((await post(payload)).statusCode).toBe(302);
    const second = await post(payload);
    expect(second.statusCode).toBe(400);
    expect(hasSession(second.cookies)).toBe(false);
  });

  it('refuses an assertion replayed into a login of the attacker’s own', async () => {
    // The one the RelayState check cannot catch. The attacker has a genuine,
    // correctly signed, unexpired assertion for somebody else — captured from
    // a log, a referer or a shared machine — starts a fresh login to obtain a
    // RelayState Syntra really issued, and posts the two together. Only the
    // signed `InResponseTo` separates this from a real sign-in.
    const victim = await start();
    const captured = upstreamResponse(victim.requestId!);

    const attacker = await start();
    const res = await post({ SAMLResponse: captured, RelayState: attacker.relayState! });
    expect(res.statusCode).toBe(400);
    expect(hasSession(res.cookies)).toBe(false);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);
    expect(await eventsOf(ctx.tenantId, 'federation.assertion_refused')).toHaveLength(1);
  });

  it('reads InResponseTo from the signature, not from the envelope', async () => {
    // The envelope is unsigned and the attacker writes it. node-saml's
    // `profile.inResponseTo` is taken from exactly there.
    const { relayState, requestId } = await start();
    const res = await post({
      SAMLResponse: upstreamResponse(requestId!, {
        inResponseTo: '_never-issued',
        envelopeInResponseTo: requestId!,
      }),
      RelayState: relayState!,
    });
    expect(res.statusCode).toBe(400);
    expect(hasSession(res.cookies)).toBe(false);
  });

  // Every one of these is an assertion the happy path cannot tell from the
  // truth without checking, and each leaves the browser with no session and
  // Syntra with no user.
  const forgeries: [string, Forgery][] = [
    ['signed by a key the upstream did not register', { rogueKey: true }],
    ['carrying no signature at all', { sign: false }],
    ['whose issuer is not the configured upstream', { issuer: 'https://evil.example' }],
    ['whose audience is another service provider', { audience: 'https://someone-else.test' }],
    ['addressed to another service provider’s ACS', { recipient: 'https://elsewhere.test/acs' }],
    ['whose conditions have expired', { now: new Date(Date.now() - 3_600_000) }],
    ['whose conditions have not yet begun', { now: new Date(Date.now() + 3_600_000) }],
    ['naming a request Syntra never issued', { inResponseTo: '_never-issued' }],
    ['naming no request at all', { inResponseTo: null }],
    [
      'whose signature covers an element other than the one read',
      {
        wrap: (signed) =>
          signed
            .replace('ID="_a1"', 'ID="_evil"')
            .replace('jdoe@acme.test</saml:NameID>', 'ceo@acme.test</saml:NameID>')
            .replace(
              '</saml:Assertion>',
              `<saml:Advice>${signed}</saml:Advice></saml:Assertion>`,
            ),
      },
    ],
  ];

  for (const [what, forged] of forgeries) {
    it(`refuses an assertion ${what}, and audits it`, async () => {
      const res = await federate(forged);
      expect(res.statusCode).toBe(400);
      expect(hasSession(res.cookies)).toBe(false);
      expect(await usersOf(ctx.tenantId)).toHaveLength(0);
      // Refused, and recorded. An upstream that starts failing verification is
      // either broken or under attack, and neither is a thing to swallow.
      expect(await eventsOf(ctx.tenantId, 'federation.assertion_refused')).toHaveLength(1);
      // And nothing internal leaks into the sentence the browser is given.
      expect(res.body).not.toContain('SubjectConfirmationData');
      expect(res.body).not.toContain('Invalid signature');
    });
  }

  it('still requires a Syntra second factor when policy asks for one', async () => {
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'mfa', outcome: 'require_mfa' }));
    const res = await federate();
    // The upstream authenticated them. Syntra still wants its own factor,
    // which is the whole reason federation runs THROUGH authorize().
    expect(res.headers.location).toMatch(/^\/(mfa|enrol)\?attempt=/);
    expect(hasSession(res.cookies)).toBe(false);
  });

  it('issues no session when policy denies, even though the upstream said yes', async () => {
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'nobody', outcome: 'deny' }));
    const res = await federate();
    expect(res.statusCode).toBe(403);
    expect(hasSession(res.cookies)).toBe(false);
  });

  it('refuses to sign in a deactivated account the upstream still recognises', async () => {
    expect((await federate()).statusCode).toBe(302);
    const user = (await usersOf(ctx.tenantId))[0]!;
    await withTenant(ctx.tenantId, (tx) => deactivateUser(tx, user.id, 'left'));

    const res = await federate();
    expect(res.statusCode).toBe(403);
    expect(hasSession(res.cookies)).toBe(false);
    // Still inactive. Signing in is not a way to come back.
    expect((await usersOf(ctx.tenantId))[0]!.status).toBe('inactive');
  });

  it('refuses to provision when the upstream may not create users, and says why', async () => {
    await setUpFederation(ctx.tenantId, { createUsers: false });
    const res = await federate();
    expect(res.statusCode).toBe(403);
    expect(hasSession(res.cookies)).toBe(false);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);
    const refusals = await eventsOf(ctx.tenantId, 'federation.provision_refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.payload).toMatchObject({ reason: 'no_local_user' });
  });

  it('refuses a profile the attribute mapping cannot identify', async () => {
    await setUpFederation(ctx.tenantId, { loginAttribute: 'upn', emailAttribute: 'upn' });
    const res = await federate();
    expect(res.statusCode).toBe(403);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);
    const refusals = await eventsOf(ctx.tenantId, 'federation.provision_refused');
    expect(refusals[0]!.payload).toMatchObject({ reason: 'incomplete_profile' });
  });

  it('refuses to start a login against an upstream with no certificate to check', async () => {
    // Nothing it ever said could be verified. Refusing before the browser
    // leaves beats refusing after it comes back with an answer.
    await setUpFederation(ctx.tenantId, { idpCertificates: [] });
    const res = await get('/federation/start?login=jdoe@acme.test');
    expect(res.statusCode).toBe(409);
    expect(await withTenant(ctx.tenantId, (tx) => tx.federationRequest.count())).toBe(0);
  });

  it('never redirects off-origin after federation', async () => {
    for (const bad of ['https://attacker.test/', '//attacker.test/', '/\\attacker.test']) {
      const { relayState, requestId } = await start('jdoe@acme.test', bad);
      const res = await post({
        SAMLResponse: upstreamResponse(requestId!),
        RelayState: relayState!,
      });
      const location = res.headers.location as string;
      expect(location.startsWith('/')).toBe(true);
      expect(location.startsWith('//')).toBe(false);
      expect(location).not.toContain('attacker.test');
    }
  });

  it('publishes SP metadata naming the tenant’s own entity ID and ACS URL', async () => {
    const res = await get('/federation/saml/metadata?upstream=adfs');
    expect(res.statusCode).toBe(200);
    const doc = parseXml(res.body);
    expect(doc.documentElement!.getAttribute('entityID')).toBe(SP);
    expect(res.body).toContain(ACS);
    // The same document without a slug, because that URL *is* the entity ID an
    // administrator pastes into their IdP.
    const bare = await get('/federation/saml/metadata');
    expect(bare.statusCode).toBe(200);
    expect(parseXml(bare.body).documentElement!.getAttribute('entityID')).toBe(SP);
  });

  it('answers 404 for metadata naming an upstream this tenant does not have', async () => {
    const res = await get('/federation/saml/metadata?upstream=nope');
    expect(res.statusCode).toBe(404);
  });

  it('refuses a protocol request that arrived on the wrong host', async () => {
    // `acme.attacker.example` resolves tenant `acme`. Nothing here — entity
    // ID, ACS URL, audience — is allowed to be derived from that.
    for (const url of ['/federation/start?login=jdoe@acme.test', '/federation/saml/metadata']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { host: 'acme.attacker.example' },
      });
      expect(res.statusCode).toBe(421);
    }
    const acs = await ctx.app.inject({
      method: 'POST',
      url: '/federation/saml/acs',
      headers: {
        host: 'acme.attacker.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ SAMLResponse: 'x', RelayState: 'y' }).toString(),
    });
    expect(acs.statusCode).toBe(421);
  });

  it('refuses a callback with a duplicated or missing parameter', async () => {
    const { relayState, requestId } = await start();
    const duplicated = await ctx.app.inject({
      method: 'POST',
      url: '/federation/saml/acs',
      headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `SAMLResponse=${encodeURIComponent(
        upstreamResponse(requestId!),
      )}&RelayState=${encodeURIComponent(relayState!)}&RelayState=other`,
    });
    expect(duplicated.statusCode).toBe(400);
    expect(hasSession(duplicated.cookies)).toBe(false);

    const missing = await post({ RelayState: relayState! });
    expect(missing.statusCode).toBe(400);
  });
});
