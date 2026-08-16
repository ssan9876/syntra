import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { generateKeyPairSync } from 'node:crypto';
import { signFragment } from '../xml/sign.js';
import { parseXml, selectElements } from '../xml/parse.js';
import {
  newAuthnRequestId,
  readUpstreamResponse,
  upstreamAuthnRedirect,
  upstreamSaml,
  upstreamSpMetadata,
  type UpstreamSamlOptions,
} from './saml-sp.js';

const IDP = 'https://idp.example.test/metadata';
const SSO = 'https://idp.example.test/sso';
const SP = 'https://sso.acme.test/federation/saml/metadata';
const ACS = 'https://sso.acme.test/federation/saml/acs';
/** The AuthnRequest Syntra issued for the login under test. */
const REQUEST = '_syntra-request-1';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const certificatePem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
const roguePrivateKeyPem = rogue.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rogueCertificatePem = rogue.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const options: UpstreamSamlOptions = {
  idpCertificates: [certificatePem],
  idpEntityId: IDP,
  ssoUrl: SSO,
  sloUrl: null,
  spEntityId: SP,
  acsUrl: ACS,
  wantAssertionsSigned: true,
};

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Forgery {
  subject?: string;
  audience?: string;
  issuer?: string;
  recipient?: string;
  /** `null` omits the attribute entirely, the way an unsolicited assertion does. */
  inResponseTo?: string | null;
  now?: Date;
  sign?: boolean;
  /** Sign with a key the upstream does not publish. */
  rogueKey?: boolean;
  /** Rewrites the signed assertion into a wrapping attempt. */
  wrap?: (signedAssertion: string) => string;
  /** What the *envelope* claims, which nothing may read. */
  envelopeInResponseTo?: string;
}

/** Builds and signs an assertion the way a real upstream IdP would. */
const upstreamResponse = (over: Forgery = {}) => {
  const now = over.now ?? new Date();
  const inResponseTo = over.inResponseTo === undefined ? REQUEST : over.inResponseTo;
  const echo = inResponseTo === null ? '' : ` InResponseTo="${inResponseTo}"`;
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${over.issuer ?? IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${over.subject ?? 'jdoe@acme.test'}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(new Date(now.getTime() + 300000))}" Recipient="${over.recipient ?? ACS}"${echo}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60000))}" NotOnOrAfter="${iso(new Date(now.getTime() + 300000))}">` +
    `<saml:AudienceRestriction><saml:Audience>${over.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_si1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="mail"><saml:AttributeValue>jdoe@acme.test</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="groups"><saml:AttributeValue>Finance</saml:AttributeValue><saml:AttributeValue>All Staff</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
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

const read = (response: string, sp = upstreamSaml(options), request = REQUEST) =>
  readUpstreamResponse(sp, response, { inResponseTo: request });

describe('upstream SAML service provider', () => {
  it('builds a redirect that carries a deflated AuthnRequest to the IdP', async () => {
    const requestId = newAuthnRequestId();
    const url = await upstreamAuthnRedirect(
      upstreamSaml({ ...options, requestId }),
      'relay-1',
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(SSO);
    expect(parsed.searchParams.get('RelayState')).toBe('relay-1');
    const xml = inflateRawSync(
      Buffer.from(parsed.searchParams.get('SAMLRequest')!, 'base64'),
    ).toString('utf8');
    const doc = parseXml(xml);
    expect(doc.documentElement!.localName).toBe('AuthnRequest');
    expect(selectElements(doc, "//*[local-name(.)='Issuer']")[0]!.textContent).toBe(SP);
    // The ID Syntra chose, so the row it stores names the request the browser
    // actually carried. Without this the ID exists only inside node-saml and
    // the response can be bound to nothing.
    expect(doc.documentElement!.getAttribute('ID')).toBe(requestId);
    expect(doc.documentElement!.getAttribute('AssertionConsumerServiceURL')).toBe(ACS);
  });

  it('mints a fresh request ID for every login', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newAuthnRequestId()));
    expect(ids.size).toBe(50);
    // xsd:ID, so it may not start with a digit.
    expect([...ids].every((id) => /^_[0-9a-f]{32}$/.test(id))).toBe(true);
  });

  it('publishes SP metadata naming the ACS URL', () => {
    const xml = upstreamSpMetadata(options);
    const doc = parseXml(xml);
    expect(doc.documentElement!.getAttribute('entityID')).toBe(SP);
    expect(
      selectElements(doc, "//*[local-name(.)='AssertionConsumerService']")[0]!.getAttribute(
        'Location',
      ),
    ).toBe(ACS);
    expect(
      selectElements(doc, "//*[local-name(.)='SPSSODescriptor']")[0]!.getAttribute(
        'WantAssertionsSigned',
      ),
    ).toBe('true');
  });

  it('reads a signed assertion and returns the subject, session index and attributes', async () => {
    const result = await read(upstreamResponse());
    expect(result.subject).toBe('jdoe@acme.test');
    expect(result.sessionIndex).toBe('_si1');
    expect(result.issuer).toBe(IDP);
    expect(result.assertionId).toBe('_a1');
    expect(result.inResponseTo).toBe(REQUEST);
    // Every attribute is a list, including the single-valued one. node-saml's
    // flattened profile would hand back a bare string for `mail`.
    expect(result.attributes.mail).toEqual(['jdoe@acme.test']);
    expect(result.attributes.groups).toEqual(['Finance', 'All Staff']);
    // And nothing the upstream did not send. node-saml synthesizes
    // `profile.email` from `mail`; reading the signed bytes does not.
    expect(result.attributes.email).toBeUndefined();
  });

  it('refuses an unsigned assertion when the upstream is configured to require one', async () => {
    await expect(read(upstreamResponse({ sign: false }))).rejects.toThrow();
  });

  it('refuses an unsigned assertion even when the tenant turned the switch off', async () => {
    // `wantAssertionsSigned: false` means "the Response signature may stand in
    // for the Assertion signature", never "no signature at all". node-saml
    // falls through to verifying the assertion when nothing else verified, and
    // this pins that: a tenant flipping the switch must not be one flip away
    // from accepting anything anybody posts.
    const lax = upstreamSaml({ ...options, wantAssertionsSigned: false });
    await expect(read(upstreamResponse({ sign: false }), lax)).rejects.toThrow();
  });

  it('refuses an assertion signed by a key that is not registered', async () => {
    await expect(read(upstreamResponse({ rogueKey: true }))).rejects.toThrow();
  });

  it('refuses everything when the upstream has no registered certificate', async () => {
    const blind = upstreamSaml({ ...options, idpCertificates: [] });
    await expect(read(upstreamResponse(), blind)).rejects.toThrow();
  });

  it('refuses an assertion whose issuer is not the configured upstream', async () => {
    // node-saml alone accepts this: `idpIssuer` is consulted by `verifyIssuer`,
    // which runs for logout messages and never for an assertion. Proved by
    // probe before the check existed.
    await expect(
      read(upstreamResponse({ issuer: 'https://evil.example' })),
    ).rejects.toThrow(/issuer/i);
  });

  it('refuses an assertion whose audience is somebody else', async () => {
    await expect(
      read(upstreamResponse({ audience: 'https://someone-else.test' })),
    ).rejects.toThrow();
  });

  it("refuses an assertion addressed to another service provider's ACS", async () => {
    // Also accepted by node-saml alone: `Recipient` is read only for its
    // validity window.
    await expect(
      read(upstreamResponse({ recipient: 'https://elsewhere.test/acs' })),
    ).rejects.toThrow(/SubjectConfirmationData/);
  });

  it('refuses an assertion whose conditions have expired', async () => {
    await expect(
      read(upstreamResponse({ now: new Date(Date.now() - 3_600_000) })),
    ).rejects.toThrow();
  });

  it('refuses an assertion whose conditions have not begun', async () => {
    await expect(
      read(upstreamResponse({ now: new Date(Date.now() + 3_600_000) })),
    ).rejects.toThrow();
  });

  it('refuses an assertion answering a request Syntra never issued', async () => {
    await expect(
      read(upstreamResponse({ inResponseTo: '_never-issued' })),
    ).rejects.toThrow(/SubjectConfirmationData/);
  });

  it('refuses an unsolicited assertion that names no request at all', async () => {
    await expect(read(upstreamResponse({ inResponseTo: null }))).rejects.toThrow(
      /SubjectConfirmationData/,
    );
  });

  it('reads InResponseTo from the signature, not from the envelope that carries it', async () => {
    // The envelope is unsigned and the attacker writes it. node-saml's
    // `profile.inResponseTo` comes from exactly there, so an implementation
    // that trusted it would accept this: the envelope names the request Syntra
    // issued while the assertion the signature covers answers a different one.
    await expect(
      read(
        upstreamResponse({ inResponseTo: '_never-issued', envelopeInResponseTo: REQUEST }),
      ),
    ).rejects.toThrow(/SubjectConfirmationData/);
  });

  it('refuses an assertion altered after signing', async () => {
    const good = Buffer.from(upstreamResponse(), 'base64').toString('utf8');
    const tampered = Buffer.from(
      good.replace('jdoe@acme.test</saml:NameID>', 'admin@acme.test</saml:NameID>'),
    ).toString('base64');
    await expect(read(tampered)).rejects.toThrow();
  });

  it('refuses a forged assertion that carries the genuine signature inside it', async () => {
    // Signature wrapping. The forged assertion is a copy with a different
    // NameID, and the real signed one is hidden in its `saml:Advice`, so the
    // document does contain a signature that verifies — over something other
    // than what a naive reader would read.
    const wrapped = upstreamResponse({
      wrap: (signed) =>
        signed
          .replace('ID="_a1"', 'ID="_evil"')
          .replace('jdoe@acme.test</saml:NameID>', 'admin@acme.test</saml:NameID>')
          .replace('</saml:Assertion>', `<saml:Advice>${signed}</saml:Advice></saml:Assertion>`),
    });
    await expect(read(wrapped)).rejects.toThrow();
  });

  it('refuses a second assertion smuggled in beside the signed one', async () => {
    const forged = (subject: string) =>
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evil" Version="2.0" IssueInstant="${iso(new Date())}">` +
      `<saml:Issuer>${IDP}</saml:Issuer>` +
      `<saml:Subject><saml:NameID>${subject}</saml:NameID></saml:Subject></saml:Assertion>`;
    const both = upstreamResponse({ wrap: (signed) => `${forged('admin@acme.test')}${signed}` });
    await expect(read(both)).rejects.toThrow();
  });

  it('refuses garbage that is not XML at all', async () => {
    await expect(read(Buffer.from('not xml').toString('base64'))).rejects.toThrow();
  });
});
