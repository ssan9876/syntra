import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { parseXml, selectElements } from './parse.js';
import { verifySignedFragment } from './verify.js';
import { signFragment } from './sign.js';
import { xmlAttr, xmlText } from './escape.js';

describe('parseXml', () => {
  it('does not expand an internal entity', () => {
    const doc = parseXml(
      `<?xml version="1.0"?><!DOCTYPE r [ <!ENTITY a "AAAAAAAAAA"> ]><r>&a;</r>`,
    );
    // @xmldom/xmldom returns the reference as literal text. This assertion is
    // the regression guard: swapping in a parser that resolves entities makes
    // it fail, which is the only way a billion-laughs or an XXE read reaches
    // this codebase.
    expect(doc.documentElement!.textContent).toBe('&a;');
  });

  it('does not resolve an external entity', () => {
    const doc = parseXml(
      `<?xml version="1.0"?><!DOCTYPE r [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]><r>&x;</r>`,
    );
    expect(doc.documentElement!.textContent).toBe('&x;');
    expect(doc.documentElement!.textContent).not.toContain('root:');
  });

  it('rejects XML that is not well formed rather than returning a partial document', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('not xml at all')).toThrow();
    expect(() => parseXml('')).toThrow();
  });
});

describe('escaping', () => {
  it('escapes the five text and attribute metacharacters', () => {
    expect(xmlText(`a<b>&"c'`)).toBe('a&lt;b&gt;&amp;&quot;c&apos;');
    expect(xmlAttr(`"><script>`)).toBe('&quot;&gt;&lt;script&gt;');
  });

  it('strips characters XML 1.0 cannot carry at all', () => {
    // A NUL in a display name would otherwise abort the parse at the far end.
    expect(xmlText('a\u0000b\u0008c')).toBe('abc');
  });
});

describe('signFragment / verifySignedFragment', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  // A certificate is what SAML carries; for this unit test a bare public key
  // in PEM is what xml-crypto verifies against, and node-saml's SAML wrapper
  // accepts either. Task 7 exercises the certificate path end to end.
  const certificatePem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const doc = (id: string, body: string) =>
    `<Envelope xmlns="urn:test"><Thing ID="${id}"><Issuer>me</Issuer>${body}</Thing></Envelope>`;

  const sign = (xml: string) =>
    signFragment(xml, {
      privateKeyPem,
      certificatePem,
      referenceXPath: "//*[local-name(.)='Thing']",
      insertAfterXPath: "//*[local-name(.)='Thing']/*[local-name(.)='Issuer']",
    });

  const verify = (xml: string) => {
    const parsed = parseXml(xml);
    const [thing] = selectElements(parsed, "//*[local-name(.)='Thing']");
    return verifySignedFragment(xml, thing!, [certificatePem]);
  };

  it('round-trips: what it signs, it verifies, and it returns the signed bytes', () => {
    const signed = sign(doc('_1', '<Value>ok</Value>'));
    const verified = verify(signed);
    expect(verified).not.toBeNull();
    expect(verified).toContain('<Value>ok</Value>');
  });

  it('refuses a document whose signed content was altered after signing', () => {
    const signed = sign(doc('_1', '<Value>ok</Value>')).replace(
      '<Value>ok</Value>',
      '<Value>tampered</Value>',
    );
    expect(verify(signed)).toBeNull();
  });

  it('refuses a signature made by a key that is not on the trusted list', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signed = signFragment(doc('_1', '<Value>ok</Value>'), {
      privateKeyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      certificatePem: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      referenceXPath: "//*[local-name(.)='Thing']",
      insertAfterXPath: "//*[local-name(.)='Thing']/*[local-name(.)='Issuer']",
    });
    expect(verify(signed)).toBeNull();
  });

  it('refuses an unsigned document', () => {
    expect(verify(doc('_1', '<Value>ok</Value>'))).toBeNull();
  });

  it('refuses a signature wrapping attack: a valid signed fragment smuggled beside a forged one', () => {
    // XSW. The attacker keeps the genuinely signed Thing, hides it inside the
    // envelope, and adds a forged Thing carrying the same ID that the reader
    // would naturally pick up. Every historical SAML bypass has this shape.
    const signed = sign(doc('_1', '<Value>ok</Value>'));
    const forged = signed.replace(
      '<Envelope xmlns="urn:test">',
      '<Envelope xmlns="urn:test"><Thing ID="_1"><Issuer>me</Issuer><Value>tampered</Value></Thing>',
    );
    const parsed = parseXml(forged);
    // Take the FIRST Thing, which is what a naive reader does.
    const [first] = selectElements(parsed, "//*[local-name(.)='Thing']");
    expect(verifySignedFragment(forged, first!, [certificatePem])).toBeNull();

    // And even asking about the genuinely signed one must fail, because the
    // ID now resolves to two elements and nothing can say which was signed.
    const things = selectElements(parsed, "//*[local-name(.)='Thing']");
    expect(verifySignedFragment(forged, things[1]!, [certificatePem])).toBeNull();
  });

  it('returns the signed bytes rather than the caller node, so a caller cannot read around the signature', () => {
    const signed = sign(doc('_1', '<Value>ok</Value>'));
    const forged = signed.replace('</Envelope>', '<Extra>attacker</Extra></Envelope>');
    const parsed = parseXml(forged);
    const [thing] = selectElements(parsed, "//*[local-name(.)='Thing']");
    const verified = verifySignedFragment(forged, thing!, [certificatePem]);
    expect(verified).not.toBeNull();
    // The Extra element is in the document but not in what was signed, and
    // the caller only ever gets what was signed.
    expect(verified).not.toContain('attacker');
  });
});
