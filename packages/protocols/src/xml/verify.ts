import { SignedXml } from 'xml-crypto';
import { selectElements } from './parse.js';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const SIGNATURE_XPATH = `./*[local-name(.)='Signature' and namespace-uri(.)='${DSIG}']`;
const TRANSFORM_XPATH = `.//*[local-name(.)='Transform' and namespace-uri(.)='${DSIG}']`;

/**
 * Verifies the enveloped signature on `node` and returns the bytes that were
 * actually signed — or null.
 *
 * **The return value is the security boundary.** Callers must parse and read
 * the returned string and must never read `node`, the surrounding document, or
 * anything else. That is what defeats XML Signature Wrapping: an attacker can
 * always arrange for a document to contain one genuinely signed element and
 * one forged element that a naive reader picks up instead, and "the signature
 * checked out" is true of the document while being false of what was read.
 * `xml-crypto`'s `getSignedReferences()` returns the canonicalized bytes of
 * the reference it verified, and nothing else in the document can influence
 * them.
 *
 * The checks before the cryptography are conformance checks, taken from the
 * recipe `@node-saml/node-saml` implements in its own `getVerifiedXml`
 * (`lib/xml.js`). They are reproduced rather than imported because that module
 * is not part of node-saml's public surface. The cryptography itself is
 * `xml-crypto`'s — none of it is hand-rolled.
 *
 * `certificates` is the trusted set: the SP's registered certificates when
 * checking an AuthnRequest, or the upstream IdP's when checking an assertion.
 * An empty list verifies nothing and returns null.
 */
export function verifySignedFragment(
  fullXml: string,
  node: Element,
  certificates: string[],
): string | null {
  if (certificates.length === 0) return null;

  const signatures = selectElements(node, SIGNATURE_XPATH);
  // Exactly one. Zero is unsigned; more than one lets an attacker supply a
  // signature the verifier picks and a payload the reader picks.
  if (signatures.length !== 1) return null;
  const signature = signatures[0]!;

  // At most the enveloped-signature transform and a canonicalization. A third
  // transform is how an XPath or XSLT transform is smuggled in to make the
  // signed bytes differ from the bytes anyone would read.
  if (selectElements(signature, TRANSFORM_XPATH).length > 2) return null;

  for (const certificate of certificates) {
    const sig = new SignedXml();
    sig.publicCert = certificate;
    try {
      sig.loadSignature(signature as never);
    } catch {
      continue;
    }

    const references = sig.getReferences();
    // One reference. Several would mean the signature covers several regions
    // and "the signed bytes" is not a single answer.
    if (references.length !== 1) continue;

    const uri = references[0]!.uri ?? '';
    const refId = uri.startsWith('#') ? uri.slice(1) : uri;
    if (refId === '') continue;
    // The ID goes into an XPath predicate below. Quote characters in it are
    // XPath injection.
    if (refId.includes("'") || refId.includes('"')) return null;

    const referenced = selectElements(
      signature.ownerDocument as unknown as Node,
      `//*[@ID="${refId}"]`,
    );
    // Exactly one element may carry the ID. Two is the wrapping attack: the
    // signature names an ID and the document offers two candidates.
    if (referenced.length !== 1) return null;
    // And it must be the element the signature is enveloped in. A signature
    // that references a sibling is a signature over something other than the
    // thing it appears to authenticate.
    if (referenced[0] !== signature.parentNode) return null;

    try {
      if (!sig.checkSignature(fullXml)) continue;
    } catch {
      continue;
    }

    const signed = sig.getSignedReferences();
    if (signed.length !== 1) return null;
    return signed[0]!;
  }

  return null;
}
