import { randomUUID } from 'node:crypto';
import { xmlAttr, xmlText } from '../xml/escape.js';
import { signFragment } from '../xml/sign.js';

const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';

/** SAML wants seconds; a fractional part upsets some SPs' parsers. */
const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const newId = () => `_${randomUUID()}`;

export interface AssertionAttribute {
  name: string;
  nameFormat: string;
  values: string[];
}

export interface AssertionInput {
  idpEntityId: string;
  spEntityId: string;
  acsUrl: string;
  nameId: string;
  nameIdFormat: string;
  sessionIndex: string;
  /** The SP's AuthnRequest ID, or null for an IdP-initiated response. */
  inResponseTo: string | null;
  attributes: AssertionAttribute[];
  lifetimeMs: number;
  authnInstant: Date;
  authnContextClassRef: string;
  now: Date;
}

export interface SigningMaterial {
  privateKeyPem: string;
  certificatePem: string;
}

/**
 * Builds and signs a SAML Response.
 *
 * **The Assertion is signed, not the Response.** Both are permitted; signing
 * the assertion is what `wantAssertionsSigned` asks for — the setting almost
 * every service provider defaults to true — and Task 9's encryption replaces
 * the Assertion element with an EncryptedAssertion, so the signature has to be
 * inside it.
 *
 * The document is assembled as a string rather than through a DOM because the
 * bytes must be stable across canonicalization, and because a DOM
 * serialization that reorders a namespace declaration invalidates the digest.
 * Every interpolated value goes through `xmlText` or `xmlAttr`: a display name
 * of `</saml:AttributeValue><saml:AttributeValue>admin` is otherwise an extra
 * attribute value the administrator never mapped, inside a document the
 * service provider will trust completely.
 *
 * `NotBefore` is set one minute back. Clock skew between an IdP and an SP is
 * routine, and an assertion refused for being one second early is a support
 * ticket nobody can reproduce.
 *
 * This exact parameter set was executed as a spike before this plan was
 * written: the output was accepted by `@node-saml/node-saml` acting as a
 * service provider and rejected with `Invalid signature` after one attribute
 * value was altered.
 */
/**
 * The signed Assertion on its own, without the SAML protocol Response around
 * it.
 *
 * Extracted because WS-Federation carries the same assertion inside a
 * `RequestSecurityTokenResponse` instead of a `samlp:Response`. Two builders
 * would be two subtly different assertions the day somebody fixed a
 * `NotBefore` in one of them, and the assertion is the part a service provider
 * actually trusts.
 */
export function buildSignedAssertion(
  input: AssertionInput,
  key: SigningMaterial,
): string {
  const assertionId = newId();
  const notBefore = new Date(input.now.getTime() - 60_000);
  const notOnOrAfter = new Date(input.now.getTime() + input.lifetimeMs);

  const inResponseToAttr = input.inResponseTo
    ? ` InResponseTo="${xmlAttr(input.inResponseTo)}"`
    : '';

  const attributes = input.attributes
    .map(
      (attribute) =>
        `<saml:Attribute Name="${xmlAttr(attribute.name)}" NameFormat="${xmlAttr(
          attribute.nameFormat,
        )}">` +
        attribute.values
          .map(
            (value) =>
              `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${xmlText(
                value,
              )}</saml:AttributeValue>`,
          )
          .join('') +
        `</saml:Attribute>`,
    )
    .join('');

  const attributeStatement =
    attributes === ''
      ? ''
      : `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>`;

  const assertion =
    `<saml:Assertion xmlns:saml="${SAML_NS}" ID="${assertionId}" Version="2.0" IssueInstant="${instant(
      input.now,
    )}">` +
    `<saml:Issuer>${xmlText(input.idpEntityId)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${xmlAttr(input.nameIdFormat)}">${xmlText(input.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${instant(
      notOnOrAfter,
    )}" Recipient="${xmlAttr(input.acsUrl)}"${inResponseToAttr}/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${instant(notBefore)}" NotOnOrAfter="${instant(notOnOrAfter)}">` +
    `<saml:AudienceRestriction><saml:Audience>${xmlText(input.spEntityId)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${instant(
      input.authnInstant,
    )}" SessionIndex="${xmlAttr(input.sessionIndex)}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>${xmlText(
      input.authnContextClassRef,
    )}</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    attributeStatement +
    `</saml:Assertion>`;

  // Signed on its own, before it is placed in the Response, so the reference
  // XPath has exactly one candidate and the enveloped-signature transform has
  // nothing else to strip.
  const signedAssertion = signFragment(assertion, {
    privateKeyPem: key.privateKeyPem,
    certificatePem: key.certificatePem,
    referenceXPath: "/*[local-name(.)='Assertion']",
    insertAfterXPath: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
  });

  return signedAssertion;
}

export function buildSignedResponse(
  input: AssertionInput,
  key: SigningMaterial,
): string {
  const responseId = newId();
  const inResponseToAttr = input.inResponseTo
    ? ` InResponseTo="${xmlAttr(input.inResponseTo)}"`
    : '';

  return (
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${responseId}" Version="2.0" IssueInstant="${instant(
      input.now,
    )}" Destination="${xmlAttr(input.acsUrl)}"${inResponseToAttr}>` +
    `<saml:Issuer>${xmlText(input.idpEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    buildSignedAssertion(input, key) +
    `</samlp:Response>`
  );
}

/** The HTML auto-post form that delivers a Response over HTTP-POST. */
export function postBindingForm(input: {
  acsUrl: string;
  samlResponse: string;
  relayState: string | null;
}): string {
  const relay =
    input.relayState === null
      ? ''
      : `<input type="hidden" name="RelayState" value="${xmlAttr(input.relayState)}"/>`;

  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Signing you in</title></head>` +
    `<body onload="document.forms[0].submit()">` +
    `<form method="post" action="${xmlAttr(input.acsUrl)}">` +
    `<input type="hidden" name="SAMLResponse" value="${xmlAttr(
      Buffer.from(input.samlResponse, 'utf8').toString('base64'),
    )}"/>` +
    relay +
    `<noscript><button type="submit">Continue</button></noscript>` +
    `</form></body></html>`
  );
}
