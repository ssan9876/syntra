import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { createPrivateKey, randomUUID, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import xmlenc from 'xml-encryption';
import { encryptAssertion } from './encrypt.js';
import {
  buildLogoutRequest,
  buildLogoutResponse,
  parseLogoutRequest,
} from './logout.js';
import { parseXml, selectElements } from '../xml/parse.js';

// `xpath`'s own type declarations force-include the DOM lib into this
// package's compilation (`/// <reference lib="dom" />`), which gives the
// global `Crypto`/`SubtleCrypto` types a newer shape (Ed25519 overloads) than
// `node:crypto`'s `webcrypto.Crypto` — a mismatch `core`'s identical call
// never hits, because `core` never imports `xpath`. `as unknown as never`
// is the established escape hatch for exactly this in this codebase (see
// `xml/parse.ts`, `xml/verify.ts`).
x509.cryptoProvider.set(webcrypto as unknown as never);

const IDP = 'https://sso.acme.test/saml/idp';

const CERT_ALG = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

/**
 * `xml-encryption`'s `pem` option is documented — and, empirically, enforced —
 * as "a valid x509 certificate encoded as PEM": its `pemToCert` helper regexes
 * for `-----BEGIN CERTIFICATE-----` and throws a bare `TypeError` (not a
 * caught, reportable error) when handed a bare SPKI public key PEM instead.
 * That is exactly what `generateKeyPairSync('rsa', ...).publicKey.export(...)`
 * produces, so this brief's original fixture — "a bare SPKI PEM works the
 * same way for this test" — does not hold for xml-encryption@6.0.0; it throws
 * before either test's assertions run. The fix is to mint a real self-signed
 * certificate over the same key pair, exactly as `signing-key-service.ts`
 * does for the tenant's own SAML certificate, so the fixture matches what
 * `encryptAssertion` actually receives from `ctx.config.encryptionCertificate`
 * in production.
 */
async function generateEncryptionCert(): Promise<{
  certificatePem: string;
  privateKeyPem: string;
}> {
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
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const privateKeyPem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  return { certificatePem: cert.toString('pem'), privateKeyPem };
}

describe('encryptAssertion', () => {
  it('produces an EncryptedAssertion the holder of the private key can open again', async () => {
    // A certificate is what an SP publishes; xml-encryption takes the public
    // key out of it.
    const { certificatePem, privateKeyPem } = await generateEncryptionCert();
    const assertion = '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_1"><saml:Issuer>x</saml:Issuer></saml:Assertion>';

    const encrypted = await encryptAssertion(assertion, certificatePem);

    const doc = parseXml(`<r xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${encrypted}</r>`);
    expect(selectElements(doc, "//*[local-name(.)='EncryptedAssertion']")).toHaveLength(1);
    // And there is no cleartext assertion left anywhere in it.
    expect(encrypted).not.toContain('<saml:Issuer>x</saml:Issuer>');

    const [encryptedData] = selectElements(doc, "//*[local-name(.)='EncryptedData']");
    const back = await new Promise<string>((resolve, reject) =>
      xmlenc.decrypt(
        encryptedData!.toString(),
        { key: privateKeyPem },
        (err, result) => (err ? reject(err) : resolve(result)),
      ),
    );
    expect(back).toContain('<saml:Issuer>x</saml:Issuer>');
  });

  it('uses AES-256-GCM and RSA-OAEP, not CBC or PKCS#1 v1.5', async () => {
    const { certificatePem } = await generateEncryptionCert();
    const encrypted = await encryptAssertion(
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_1"/>',
      certificatePem,
    );
    // CBC without an authenticated mode is the padding-oracle shape that has
    // produced real SAML decryption attacks, and rsa-1_5 is Bleichenbacher.
    expect(encrypted).toContain('http://www.w3.org/2009/xmlenc11#aes256-gcm');
    expect(encrypted).toContain('http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p');
    expect(encrypted).not.toContain('aes256-cbc');
    expect(encrypted).not.toContain('xmlenc#rsa-1_5');
  });
});

describe('logout messages', () => {
  it('parses a LogoutRequest', () => {
    const xml = `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr1" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${IDP}"><saml:Issuer>https://sp.example.test/metadata</saml:Issuer><saml:NameID>j@acme.test</saml:NameID><samlp:SessionIndex>_si1</samlp:SessionIndex></samlp:LogoutRequest>`;
    const parsed = parseLogoutRequest(xml);
    expect(parsed).toMatchObject({
      id: '_lr1',
      issuer: 'https://sp.example.test/metadata',
      nameId: 'j@acme.test',
      sessionIndex: '_si1',
    });
  });

  it('refuses a document that is not a LogoutRequest', () => {
    expect(() =>
      parseLogoutRequest('<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_1"/>'),
    ).toThrow(/LogoutRequest/);
  });

  it('builds a LogoutRequest and a LogoutResponse that parse and carry the right ids', () => {
    const { id, xml } = buildLogoutRequest({
      idpEntityId: IDP,
      destination: 'https://sp.example.test/slo',
      nameId: 'j@acme.test',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      sessionIndex: '_si1',
      now: new Date(),
    });
    expect(id).toMatch(/^_/);
    expect(parseLogoutRequest(xml).nameId).toBe('j@acme.test');

    const response = buildLogoutResponse({
      idpEntityId: IDP,
      destination: 'https://sp.example.test/slo',
      inResponseTo: '_lr1',
      success: true,
      now: new Date(),
    });
    const doc = parseXml(response);
    expect(doc.documentElement!.getAttribute('InResponseTo')).toBe('_lr1');
    expect(
      selectElements(doc, "//*[local-name(.)='StatusCode']")[0]!.getAttribute('Value'),
    ).toBe('urn:oasis:names:tc:SAML:2.0:status:Success');
  });

  it('escapes a hostile NameID rather than letting it close the element', () => {
    const { xml } = buildLogoutRequest({
      idpEntityId: IDP,
      destination: 'https://sp.example.test/slo',
      nameId: '</saml:NameID><evil/>',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      sessionIndex: '_si1',
      now: new Date(),
    });
    expect(xml).not.toContain('<evil/>');
    expect(parseLogoutRequest(xml).nameId).toBe('</saml:NameID><evil/>');
  });
});
