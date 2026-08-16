import { SignedXml } from 'xml-crypto';

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

export interface SignOptions {
  /** PKCS#8 PEM. */
  privateKeyPem: string;
  /** PEM certificate, published in ds:KeyInfo so an SP can pin it. */
  certificatePem: string;
  /** Selects the element the signature covers. */
  referenceXPath: string;
  /**
   * The signature is inserted immediately after this element. SAML requires
   * ds:Signature to follow saml:Issuer inside the element it signs.
   */
  insertAfterXPath: string;
}

/**
 * Signs one element of a document with an enveloped RSA-SHA256 signature.
 *
 * SHA-256 and exclusive canonicalization throughout: SHA-1 signatures are
 * still accepted by some service providers and are not offered here, because
 * the only party who benefits from a downgrade option is an attacker.
 *
 * The exact parameter set below was verified end to end during planning: an
 * assertion signed with it was accepted by `@node-saml/node-saml` acting as a
 * service provider, and rejected with "Invalid signature" after one attribute
 * value was altered. Task 7 keeps that round trip as a test.
 */
export function signFragment(xml: string, opts: SignOptions): string {
  const sig = new SignedXml({
    privateKey: opts.privateKeyPem,
    publicCert: opts.certificatePem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: EXC_C14N,
  });

  sig.addReference({
    xpath: opts.referenceXPath,
    transforms: [ENVELOPED, EXC_C14N],
    digestAlgorithm: SHA256,
  });

  sig.computeSignature(xml, {
    prefix: 'ds',
    location: { reference: opts.insertAfterXPath, action: 'after' },
  });

  return sig.getSignedXml();
}
