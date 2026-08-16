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
