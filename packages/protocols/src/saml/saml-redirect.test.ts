import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { decodeRedirectMessage, verifyRedirectSignature } from './authn-request.js';

const SP = 'https://sp.example.test/metadata';
const ACS = 'https://sp.example.test/acs';
const SIG_ALG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';

const authnRequestXml = (acs = ACS) =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${acs}"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

const encode = (xml: string) => deflateRawSync(Buffer.from(xml)).toString('base64');

describe('decodeRedirectMessage', () => {
  it('inflates a raw DEFLATE stream', () => {
    const xml = authnRequestXml();
    expect(decodeRedirectMessage(encode(xml))).toBe(xml);
  });

  it('refuses a message that inflates past the ceiling', () => {
    // A 30 MB run of spaces deflates to a few kilobytes. Without a ceiling the
    // decoder allocates the whole thing before anything else runs, which is a
    // decompression bomb against an unauthenticated endpoint.
    const bomb = deflateRawSync(Buffer.alloc(30 * 1024 * 1024, 0x20)).toString('base64');
    expect(() => decodeRedirectMessage(bomb)).toThrow(/too large/i);
  });

  it('refuses an empty parameter and one that is not a DEFLATE stream', () => {
    expect(() => decodeRedirectMessage('')).toThrow();
    expect(() => decodeRedirectMessage(Buffer.from('not deflated').toString('base64')))
      .toThrow(/decompress/i);
  });
});

describe('verifyRedirectSignature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sign = (rawQuery: string) =>
    createSign('RSA-SHA256').update(rawQuery).sign(privatePem).toString('base64');

  it('accepts a signature over the exact raw query substring', () => {
    const raw = `SAMLRequest=${encodeURIComponent(encode(authnRequestXml()))}&RelayState=${encodeURIComponent('r1')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({
        rawQuery: raw, signature: sign(raw), sigAlg: SIG_ALG, certificates: [publicPem],
      }),
    ).toBe(true);
  });

  it('refuses when the request the signature covered has been swapped for another', () => {
    // The attack: the signature stays, the SAMLRequest changes so that the ACS
    // URL points at the attacker. This is what the whole check exists for.
    const raw = `SAMLRequest=${encodeURIComponent(encode(authnRequestXml()))}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const signature = sign(raw);
    const swapped = `SAMLRequest=${encodeURIComponent(encode(authnRequestXml('https://attacker.test/acs')))}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({ rawQuery: swapped, signature, sigAlg: SIG_ALG, certificates: [publicPem] }),
    ).toBe(false);
  });

  it('refuses when the RelayState the signature covered has been altered', () => {
    const request = encodeURIComponent(encode(authnRequestXml()));
    const raw = `SAMLRequest=${request}&RelayState=${encodeURIComponent('r1')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const signature = sign(raw);
    const altered = `SAMLRequest=${request}&RelayState=${encodeURIComponent('r2')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({ rawQuery: altered, signature, sigAlg: SIG_ALG, certificates: [publicPem] }),
    ).toBe(false);
  });

  it('refuses a SigAlg this build does not implement rather than defaulting to one', () => {
    const raw = 'SAMLRequest=x&SigAlg=whatever';
    // A verifier that treats an unknown algorithm as "probably SHA-1" is how
    // an algorithm-confusion bypass gets in, and SHA-1 is not offered at all.
    for (const alg of ['whatever', 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', '']) {
      expect(
        verifyRedirectSignature({ rawQuery: raw, signature: sign(raw), sigAlg: alg, certificates: [publicPem] }),
      ).toBe(false);
    }
  });

  it('refuses an empty certificate list and an empty signature', () => {
    const raw = `SAMLRequest=x&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({ rawQuery: raw, signature: sign(raw), sigAlg: SIG_ALG, certificates: [] }),
    ).toBe(false);
    expect(
      verifyRedirectSignature({ rawQuery: raw, signature: '', sigAlg: SIG_ALG, certificates: [publicPem] }),
    ).toBe(false);
  });

  it('accepts when any one of several registered certificates verifies, so a rollover works', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const raw = `SAMLRequest=${encodeURIComponent(encode(authnRequestXml()))}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({
        rawQuery: raw, signature: sign(raw), sigAlg: SIG_ALG, certificates: [otherPem, publicPem],
      }),
    ).toBe(true);
  });
});
