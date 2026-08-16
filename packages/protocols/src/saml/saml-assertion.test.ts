import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pkg from '@node-saml/node-saml';
import { buildSignedResponse, postBindingForm } from './assertion.js';
import { decodePostMessage, parseAuthnRequest } from './authn-request.js';

const { SAML } = pkg;

const IDP = 'https://sso.acme.test/saml/idp';
const SP = 'https://sp.example.test/metadata';
const ACS = 'https://sp.example.test/acs';

const authnRequestXml = (id: string, acs = ACS) =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="https://sso.acme.test/saml/sso" AssertionConsumerServiceURL="${acs}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

describe('decodePostMessage', () => {
  it('decodes base64 and does not inflate', () => {
    const xml = authnRequestXml('_a');
    expect(decodePostMessage(Buffer.from(xml).toString('base64'))).toBe(xml);
  });

  it('refuses an empty message and one past the ceiling', () => {
    expect(() => decodePostMessage('')).toThrow();
    expect(() =>
      decodePostMessage(Buffer.alloc(600 * 1024, 0x20).toString('base64')),
    ).toThrow(/too large/i);
  });
});

describe('parseAuthnRequest', () => {
  it('reads the id, issuer, ACS URL and ForceAuthn', () => {
    const parsed = parseAuthnRequest(authnRequestXml('_abc'));
    expect(parsed.id).toBe('_abc');
    expect(parsed.issuer).toBe(SP);
    expect(parsed.acsUrl).toBe(ACS);
    expect(parsed.forceAuthn).toBe(false);
  });

  it('refuses a request with no Issuer rather than returning an empty one', () => {
    const noIssuer = authnRequestXml('_abc').replace(`<saml:Issuer>${SP}</saml:Issuer>`, '');
    // An empty issuer would look up no SamlConfig and the flow would refuse
    // anyway. Throwing is what stops a later change turning "no issuer" into
    // "the first config in the table".
    expect(() => parseAuthnRequest(noIssuer)).toThrow(/issuer/i);
  });

  it('refuses a document that is not an AuthnRequest', () => {
    expect(() =>
      parseAuthnRequest(
        '<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_1"><x/></samlp:LogoutRequest>',
      ),
    ).toThrow(/AuthnRequest/);
  });

  it('does not expand an entity hidden in the request', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE samlp:AuthnRequest [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>${authnRequestXml('_abc').replace(SP, '&x;')}`;
    expect(parseAuthnRequest(xxe).issuer).not.toContain('root:');
  });
});

describe('buildSignedResponse — validated by a real service provider', () => {
  /** A certificate produced exactly the way Task 3 produces one. */
  const makeKey = async () => {
    await import('reflect-metadata');
    const x509 = await import('@peculiar/x509');
    const { webcrypto, createPrivateKey } = await import('node:crypto');
    x509.cryptoProvider.set(webcrypto as never);
    const alg = {
      name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
      publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048,
    } as const;
    const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
    const privateKeyPem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01', name: 'CN=sso.acme.test',
      notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000),
      signingAlgorithm: alg, keys,
      extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
    });
    return { privateKeyPem, certificatePem: cert.toString('pem') };
  };

  const input = (over: Partial<Parameters<typeof buildSignedResponse>[0]> = {}) => ({
    idpEntityId: IDP,
    spEntityId: SP,
    acsUrl: ACS,
    nameId: 'j@acme.test',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    sessionIndex: `_${randomUUID()}`,
    inResponseTo: '_req1',
    attributes: [
      { name: 'mail', nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic', values: ['j@acme.test'] },
      { name: 'groups', nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic', values: ['Finance', 'All Staff'] },
    ],
    lifetimeMs: 300_000,
    authnInstant: new Date(),
    authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
    now: new Date(),
    ...over,
  });

  const sp = (certificatePem: string) =>
    new SAML({
      idpCert: certificatePem,
      issuer: SP, callbackUrl: ACS, audience: SP,
      wantAuthnResponseSigned: false, wantAssertionsSigned: true,
      validateInResponseTo: 'never' as never, acceptedClockSkewMs: 5000,
    });

  it('issues a response a real service provider validates, with the mapped attributes', async () => {
    const key = await makeKey();
    const xml = buildSignedResponse(input(), key);
    const { profile } = await sp(key.certificatePem).validatePostResponseAsync({
      SAMLResponse: Buffer.from(xml).toString('base64'),
    });
    expect(profile!.nameID).toBe('j@acme.test');
    expect(profile!.issuer).toBe(IDP);
    expect(profile!.mail).toBe('j@acme.test');
    expect(profile!.groups).toEqual(['Finance', 'All Staff']);
  });

  it('is rejected by that service provider once one attribute value is altered', async () => {
    const key = await makeKey();
    const xml = buildSignedResponse(input(), key).replace(
      'j@acme.test</saml:AttributeValue>',
      'attacker@evil.test</saml:AttributeValue>',
    );
    await expect(
      sp(key.certificatePem).validatePostResponseAsync({
        SAMLResponse: Buffer.from(xml).toString('base64'),
      }),
    ).rejects.toThrow(/Invalid signature/i);
  });

  it('is rejected when the audience is somebody else', async () => {
    const key = await makeKey();
    const xml = buildSignedResponse(input({ spEntityId: 'https://someone-else.test' }), key);
    await expect(
      sp(key.certificatePem).validatePostResponseAsync({
        SAMLResponse: Buffer.from(xml).toString('base64'),
      }),
    ).rejects.toThrow();
  });

  it('is rejected once its NotOnOrAfter has passed', async () => {
    const key = await makeKey();
    const past = new Date(Date.now() - 3_600_000);
    const xml = buildSignedResponse(
      input({ now: past, authnInstant: past, lifetimeMs: 60_000 }),
      key,
    );
    await expect(
      sp(key.certificatePem).validatePostResponseAsync({
        SAMLResponse: Buffer.from(xml).toString('base64'),
      }),
    ).rejects.toThrow();
  });

  it('escapes a hostile display name instead of letting it inject an element', async () => {
    const key = await makeKey();
    const hostile = '</saml:AttributeValue><saml:AttributeValue>injected';
    const xml = buildSignedResponse(
      input({
        attributes: [{
          name: 'displayName',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
          values: [hostile],
        }],
      }),
      key,
    );
    const { profile } = await sp(key.certificatePem).validatePostResponseAsync({
      SAMLResponse: Buffer.from(xml).toString('base64'),
    });
    // One value carrying the literal text — not two values.
    expect(profile!.displayName).toBe(hostile);
  });
});

describe('postBindingForm', () => {
  it('posts to the ACS URL and escapes the relay state', () => {
    const html = postBindingForm({
      acsUrl: ACS, samlResponse: '<Response/>', relayState: '"><script>x</script>',
    });
    expect(html).toContain(`action="${ACS}"`);
    expect(html).not.toContain('<script>');
    expect(html).toContain('name="SAMLResponse"');
  });

  it('omits RelayState entirely when there is none, rather than sending an empty one', () => {
    const html = postBindingForm({ acsUrl: ACS, samlResponse: '<Response/>', relayState: null });
    expect(html).not.toContain('RelayState');
  });
});
