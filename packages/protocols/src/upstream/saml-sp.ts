import { randomBytes } from 'node:crypto';
import {
  SAML,
  ValidateInResponseTo,
  generateServiceProviderMetadata,
  type Profile,
} from '@node-saml/node-saml';
import { parseXml, selectElements } from '../xml/parse.js';

/**
 * Syntra acting as a SAML service provider against an upstream identity
 * provider.
 *
 * `@node-saml/node-saml` does the cryptography and it does it well: at 5.1.0
 * `validatePostResponseAsync` verifies the signature through `getVerifiedXml`,
 * which returns `xml-crypto`'s `getSignedReferences()` and re-parses *those
 * bytes* — the same discipline Task 5's `verifySignedFragment` established for
 * the identity-provider half — and it checks the audience, the `Conditions`
 * window and the subject-confirmation window.
 *
 * **It does not check everything its own options imply.** Verified empirically
 * against 5.1.0 rather than read out of its documentation, with a locally
 * signed assertion and a trusted certificate:
 *
 * - `<Issuer>https://evil.example</Issuer>` with `idpIssuer` configured:
 *   accepted. `idpIssuer` is only consulted by `verifyIssuer`, which node-saml
 *   calls for a LogoutRequest and a LogoutResponse and never for an assertion.
 * - `Recipient` naming a different service provider's ACS: accepted. The
 *   attribute is read only for its `NotBefore`/`NotOnOrAfter`.
 * - `SubjectConfirmationData/@InResponseTo` naming a request nobody issued:
 *   accepted. Worse, `profile.inResponseTo` is lifted from the **unsigned**
 *   `samlp:Response` envelope — an assertion whose signed `InResponseTo` says
 *   `_never-issued` reports `_syntra-request-1` if the envelope says so, so a
 *   caller that trusts that field is checking a value the attacker wrote.
 * - `samlp:Status` of `Requester` with a signed assertion present: accepted.
 *
 * So `readUpstreamResponse` re-parses the bytes the signature actually covered
 * and makes those decisions itself. Nothing here reads the response envelope.
 */
export interface UpstreamSamlOptions {
  /** PEM certificates trusted to have signed an assertion. */
  idpCertificates: string[];
  /**
   * The upstream's entity ID. When set, the signed assertion must name it as
   * its `Issuer`; node-saml will not do this for us.
   */
  idpEntityId: string | null;
  ssoUrl: string;
  sloUrl: string | null;
  /** Syntra's entity ID for this upstream. Becomes the expected audience. */
  spEntityId: string;
  acsUrl: string;
  wantAssertionsSigned: boolean;
  /**
   * The `ID` this instance puts on the AuthnRequest it builds.
   *
   * Supplied by the caller rather than left to node-saml's own generator
   * because it is the value the response has to echo, and Syntra has to have
   * written it down before the browser leaves. See `readUpstreamResponse`.
   */
  requestId?: string | undefined;
}

/** A `SAML` instance and the options it was built from, which it hides. */
export interface UpstreamSp {
  readonly saml: SAML;
  readonly options: UpstreamSamlOptions;
}

/**
 * An AuthnRequest ID.
 *
 * `xsd:ID`, so it may not begin with a digit — hence the leading underscore,
 * which is also what every SAML implementation emits. 128 bits from the
 * CSPRNG, because this value is what binds a response to a request Syntra
 * really started, and a guessable one binds nothing.
 */
export function newAuthnRequestId(): string {
  return `_${randomBytes(16).toString('hex')}`;
}

export function upstreamSaml(options: UpstreamSamlOptions): UpstreamSp {
  const saml = new SAML({
    idpCert: options.idpCertificates,
    issuer: options.spEntityId,
    callbackUrl: options.acsUrl,
    entryPoint: options.ssoUrl,
    // The audience Syntra requires the assertion to name. `false` would
    // disable the audience check entirely, which turns any assertion the
    // upstream ever issued — including one meant for a different service
    // provider — into a valid Syntra login.
    audience: options.spEntityId,
    ...(options.idpEntityId ? { idpIssuer: options.idpEntityId } : {}),
    ...(options.sloUrl ? { logoutUrl: options.sloUrl } : {}),
    ...(options.requestId ? { generateUniqueId: () => options.requestId! } : {}),
    wantAssertionsSigned: options.wantAssertionsSigned,
    // The Response envelope itself need not be signed as long as the Assertion
    // inside it is — signing the assertion is what almost every upstream does,
    // and it is the stronger of the two. node-saml still demands a verified
    // signature on one or the other: with both switches off it falls through
    // to `!validSignature` and verifies the assertion anyway, so an entirely
    // unsigned response has no path through even for a tenant who turned
    // `wantAssertionsSigned` off.
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    // Syntra keeps its own single-use `FederationRequest` row and checks the
    // signed `InResponseTo` against the AuthnRequest ID stored on it, which is
    // a stronger replay defence than node-saml's in-memory cache and survives
    // a restart and a second process. Turning node-saml's cache on as well
    // would refuse every response on whichever worker did not issue the
    // request.
    validateInResponseTo: ValidateInResponseTo.never,
    acceptedClockSkewMs: 5000,
  });
  return { saml, options };
}

export function upstreamSpMetadata(options: UpstreamSamlOptions): string {
  return generateServiceProviderMetadata({
    issuer: options.spEntityId,
    callbackUrl: options.acsUrl,
    wantAssertionsSigned: options.wantAssertionsSigned,
    identifierFormat: null,
  });
}

/**
 * The redirect that starts an upstream login.
 *
 * `RelayState` carries Syntra's own `FederationRequest` state, which is what
 * the callback is looked up by; the AuthnRequest `ID` is what the *assertion*
 * is matched against, and it comes from `options.requestId`.
 */
export async function upstreamAuthnRedirect(
  sp: UpstreamSp,
  relayState: string,
): Promise<string> {
  return sp.saml.getAuthorizeUrlAsync(relayState, undefined, {});
}

export interface UpstreamAssertion {
  /** The signed assertion's `ID`. Recorded, so a refusal can be traced. */
  assertionId: string;
  /** The `Issuer` the signature covered. */
  issuer: string;
  subject: string;
  sessionIndex: string | null;
  attributes: Record<string, string[]>;
  /** The request this assertion answered. The signed value, never the envelope's. */
  inResponseTo: string;
}

const ASSERTION = "/*[local-name(.)='Assertion']";
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

/**
 * Verifies an upstream Response and returns what the signature actually said.
 *
 * `expected.inResponseTo` is the `ID` of the AuthnRequest Syntra issued for
 * this login, read back out of the single-use `FederationRequest` row. It is
 * not optional and there is no unsolicited path: an assertion Syntra did not
 * ask for is one the upstream minted for somebody else's flow, or one an
 * attacker captured and is replaying into a login of their own, and matching
 * the RelayState excludes neither — the attacker chooses the RelayState by
 * starting a login of their own and posting somebody else's assertion into it.
 *
 * Throws on any failure, and every one is a refusal the caller has no way to
 * proceed past. The message is for the log; the browser gets one sentence for
 * all of them, so a forged assertion cannot be used to discover which check it
 * has yet to satisfy.
 */
export async function readUpstreamResponse(
  sp: UpstreamSp,
  samlResponse: string,
  expected: { inResponseTo: string },
): Promise<UpstreamAssertion> {
  const { profile } = await sp.saml.validatePostResponseAsync({
    SAMLResponse: samlResponse,
  });
  if (!profile) throw new Error('upstream response carried no assertion');

  // THE SECURITY BOUNDARY. `getAssertionXml()` is node-saml's view of
  // `xml-crypto`'s `getSignedReferences()[0]` — the bytes the signature
  // covered and nothing else. Everything below is read from a fresh parse of
  // those bytes; the surrounding `samlp:Response` is not read at all, here or
  // in the caller. That is what defeats signature wrapping: a document can
  // always be arranged to hold one genuinely signed element and one forged
  // element a naive reader picks up instead, and "the signature checked out"
  // is then true of the document while being false of what was read.
  const signedXml = (profile as Profile).getAssertionXml?.();
  if (typeof signedXml !== 'string' || signedXml === '') {
    throw new Error('upstream response exposed no signed assertion');
  }

  const doc = parseXml(signedXml);
  if (doc.documentElement?.localName !== 'Assertion') {
    throw new Error('signed content is not a SAML assertion');
  }

  const assertionId = doc.documentElement.getAttribute('ID') ?? '';
  if (assertionId === '') throw new Error('signed assertion has no ID');

  // Issuer. node-saml's `idpIssuer` is consulted only for logout messages, so
  // without this an assertion signed by a trusted certificate but claiming any
  // issuer at all is accepted. That matters wherever one signing certificate
  // covers more than one entity ID, and it matters for the audit record: the
  // issuer is what `Principal.external` carries into the decision log.
  const issuers = selectElements(doc, `${ASSERTION}/*[local-name(.)='Issuer']`);
  if (issuers.length !== 1) throw new Error('signed assertion has no single Issuer');
  const issuer = (issuers[0]!.textContent ?? '').trim();
  if (issuer === '') throw new Error('signed assertion has an empty Issuer');
  if (sp.options.idpEntityId !== null && issuer !== sp.options.idpEntityId) {
    throw new Error(`signed assertion issuer ${issuer} is not ${sp.options.idpEntityId}`);
  }

  // Subject confirmation. node-saml reads these only for their validity
  // window, so `Recipient` and `InResponseTo` go unchecked without this. At
  // least one bearer confirmation must name this ACS URL *and* the request
  // Syntra issued — one element satisfying both, not one satisfying each.
  const confirmations = selectElements(
    doc,
    `${ASSERTION}/*[local-name(.)='Subject']/*[local-name(.)='SubjectConfirmation']` +
      `[@Method='${BEARER}']/*[local-name(.)='SubjectConfirmationData']`,
  );
  const bound = confirmations.some(
    (data) =>
      data.getAttribute('Recipient') === sp.options.acsUrl &&
      data.getAttribute('InResponseTo') === expected.inResponseTo,
  );
  if (!bound) {
    throw new Error(
      `no bearer SubjectConfirmationData naming ${sp.options.acsUrl} and request ${expected.inResponseTo}`,
    );
  }

  const nameIds = selectElements(
    doc,
    `${ASSERTION}/*[local-name(.)='Subject']/*[local-name(.)='NameID']`,
  );
  if (nameIds.length !== 1) throw new Error('signed assertion has no single NameID');
  const subject = (nameIds[0]!.textContent ?? '').trim();
  if (subject === '') throw new Error('signed assertion has an empty NameID');

  const statements = selectElements(doc, `${ASSERTION}/*[local-name(.)='AuthnStatement']`);
  const sessionIndex = statements[0]?.getAttribute('SessionIndex') || null;

  // Attributes, read off the signed bytes rather than off node-saml's
  // flattened `profile`. The flattened view merges attribute names into the
  // same object as `nameID` and `issuer`, synthesizes an `email` from `mail`
  // that the upstream never sent, and collapses a one-element attribute to a
  // bare string. One shape here: every attribute is a list.
  const attributes: Record<string, string[]> = {};
  for (const attribute of selectElements(
    doc,
    `${ASSERTION}/*[local-name(.)='AttributeStatement']/*[local-name(.)='Attribute']`,
  )) {
    const name = attribute.getAttribute('Name');
    if (!name) continue;
    const values = selectElements(attribute, `./*[local-name(.)='AttributeValue']`).map(
      (value) => value.textContent ?? '',
    );
    attributes[name] = [...(attributes[name] ?? []), ...values];
  }

  return {
    assertionId,
    issuer,
    subject,
    sessionIndex,
    attributes,
    inResponseTo: expected.inResponseTo,
  };
}
