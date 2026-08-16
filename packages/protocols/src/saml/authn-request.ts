import { createVerify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { parseXml, selectElements } from '../xml/parse.js';
import { verifySignedFragment } from '../xml/verify.js';

/**
 * No legitimate AuthnRequest is anywhere near this. Task 8's Redirect decoder
 * uses the same ceiling as its decompression bound.
 */
export const MAX_MESSAGE_BYTES = 512 * 1024;

/** Decodes an HTTP-POST binding message: base64 only, never deflated. */
export function decodePostMessage(param: string): string {
  const raw = Buffer.from(param, 'base64');
  if (raw.length === 0) throw new Error('empty SAML message');
  if (raw.length > MAX_MESSAGE_BYTES) throw new Error('SAML message too large');
  return raw.toString('utf8');
}

export interface IncomingAuthnRequest {
  id: string;
  issuer: string;
  /** As requested. Not yet checked against any allowlist. */
  acsUrl: string | null;
  nameIdFormat: string | null;
  forceAuthn: boolean;
  destination: string | null;
  issueInstant: Date;
}

/**
 * Reads an AuthnRequest.
 *
 * Nothing here is trusted. This is a read of an attacker-controlled document:
 * the ACS URL it names is checked against the allowlist by `resolveAcsUrl`,
 * and the signature — if the service provider registered certificates — is
 * checked by `verifyPostSignature` here or `verifyRedirectSignature` in Task 8
 * before any of it is acted on.
 */
export function parseAuthnRequest(xml: string): IncomingAuthnRequest {
  const doc = parseXml(xml);
  const root = doc.documentElement!;
  if (root.localName !== 'AuthnRequest') {
    throw new Error(`expected an AuthnRequest, got ${root.localName}`);
  }

  const id = root.getAttribute('ID') ?? '';
  if (id === '') throw new Error('AuthnRequest has no ID');

  const [issuerNode] = selectElements(root, "./*[local-name(.)='Issuer']");
  const issuer = (issuerNode?.textContent ?? '').trim();
  if (issuer === '') throw new Error('AuthnRequest has no Issuer');

  const [policy] = selectElements(root, "./*[local-name(.)='NameIDPolicy']");

  const instant = root.getAttribute('IssueInstant');
  const issueInstant = instant ? new Date(instant) : new Date(NaN);
  if (Number.isNaN(issueInstant.getTime())) {
    throw new Error('AuthnRequest has no usable IssueInstant');
  }

  return {
    id,
    issuer,
    acsUrl: root.getAttribute('AssertionConsumerServiceURL'),
    nameIdFormat: policy?.getAttribute('Format') ?? null,
    forceAuthn: root.getAttribute('ForceAuthn') === 'true',
    destination: root.getAttribute('Destination'),
    issueInstant,
  };
}

/**
 * Verifies an HTTP-POST binding signature and returns the bytes that were
 * signed.
 *
 * Delegates to the XSW-hardened wrapper, so the caller must re-parse the
 * returned string and read *that* — never the document it passed in. A
 * document can always be arranged to contain one genuinely signed
 * AuthnRequest and one forged one that a naive reader picks up instead.
 */
export function verifyPostSignature(
  xml: string,
  certificates: string[],
): string | null {
  const doc = parseXml(xml);
  return verifySignedFragment(xml, doc.documentElement!, certificates);
}

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const RSA_SHA512 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512';

/**
 * Decodes an HTTP-Redirect binding message: base64, then a raw DEFLATE stream
 * with no zlib header.
 *
 * `maxOutputLength` is the whole point. Redirect-binding messages arrive on an
 * unauthenticated endpoint and are attacker-supplied, and a few kilobytes of
 * base64 can inflate to hundreds of megabytes. Node's zlib throws once the
 * ceiling is passed rather than allocating the rest.
 */
export function decodeRedirectMessage(param: string): string {
  const compressed = Buffer.from(param, 'base64');
  if (compressed.length === 0) throw new Error('empty SAML message');
  try {
    return inflateRawSync(compressed, {
      maxOutputLength: MAX_MESSAGE_BYTES,
    }).toString('utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/buffer|maxOutputLength|length/i.test(message)) {
      throw new Error('SAML message too large once decompressed');
    }
    throw new Error(`SAML message could not be decompressed: ${message}`);
  }
}

/**
 * Verifies an HTTP-Redirect binding signature.
 *
 * This is not XML-DSig. The signature covers the raw query string —
 * `SAMLRequest=...&RelayState=...&SigAlg=...` in exactly that order, with
 * exactly the percent-encoding the sender used. Re-encoding the parameters
 * from a parsed object produces different bytes and every legitimate signature
 * fails, which is why the caller passes the raw substring lifted out of
 * `request.raw.url` rather than anything Fastify parsed.
 *
 * An unrecognised `SigAlg` returns false rather than falling back to a
 * default. A verifier that treats an unknown algorithm as "probably SHA-1" is
 * how an algorithm-confusion bypass gets in, and SHA-1 is not offered here at
 * all.
 *
 * Every registered certificate is tried, so a service provider rotating its
 * signing key can register both for the overlap. `certificates` being empty
 * verifies nothing and returns false — the caller has already refused that
 * case with a clearer message, and this is the backstop.
 */
export function verifyRedirectSignature(input: {
  rawQuery: string;
  signature: string;
  sigAlg: string;
  certificates: string[];
}): boolean {
  if (input.certificates.length === 0) return false;

  const digest =
    input.sigAlg === RSA_SHA256
      ? 'RSA-SHA256'
      : input.sigAlg === RSA_SHA512
        ? 'RSA-SHA512'
        : null;
  if (digest === null) return false;

  const signature = Buffer.from(input.signature, 'base64');
  if (signature.length === 0) return false;

  return input.certificates.some((certificate) => {
    try {
      return createVerify(digest)
        .update(input.rawQuery)
        .verify(certificate, signature);
    } catch {
      return false;
    }
  });
}
