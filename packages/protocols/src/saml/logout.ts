import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { xmlAttr, xmlText } from '../xml/escape.js';
import { parseXml, selectElements } from '../xml/parse.js';

const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const newId = () => `_${randomUUID()}`;

export interface IncomingLogoutRequest {
  id: string;
  issuer: string;
  nameId: string;
  sessionIndex: string | null;
  destination: string | null;
}

export function parseLogoutRequest(xml: string): IncomingLogoutRequest {
  const doc = parseXml(xml);
  const root = doc.documentElement!;
  if (root.localName !== 'LogoutRequest') {
    throw new Error(`expected a LogoutRequest, got ${root.localName}`);
  }
  const id = root.getAttribute('ID') ?? '';
  if (id === '') throw new Error('LogoutRequest has no ID');

  const [issuerNode] = selectElements(root, "./*[local-name(.)='Issuer']");
  const [nameIdNode] = selectElements(root, "./*[local-name(.)='NameID']");
  const [indexNode] = selectElements(root, "./*[local-name(.)='SessionIndex']");

  const issuer = (issuerNode?.textContent ?? '').trim();
  const nameId = (nameIdNode?.textContent ?? '').trim();
  if (issuer === '') throw new Error('LogoutRequest has no Issuer');
  if (nameId === '') throw new Error('LogoutRequest has no NameID');

  return {
    id,
    issuer,
    nameId,
    sessionIndex: (indexNode?.textContent ?? '').trim() || null,
    destination: root.getAttribute('Destination'),
  };
}

export function buildLogoutRequest(input: {
  idpEntityId: string;
  destination: string;
  nameId: string;
  nameIdFormat: string;
  sessionIndex: string;
  now: Date;
}): { id: string; xml: string } {
  const id = newId();
  return {
    id,
    xml:
      `<samlp:LogoutRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${id}" Version="2.0" IssueInstant="${instant(
        input.now,
      )}" Destination="${xmlAttr(input.destination)}">` +
      `<saml:Issuer>${xmlText(input.idpEntityId)}</saml:Issuer>` +
      `<saml:NameID Format="${xmlAttr(input.nameIdFormat)}">${xmlText(input.nameId)}</saml:NameID>` +
      `<samlp:SessionIndex>${xmlText(input.sessionIndex)}</samlp:SessionIndex>` +
      `</samlp:LogoutRequest>`,
  };
}

export function buildLogoutResponse(input: {
  idpEntityId: string;
  destination: string;
  inResponseTo: string;
  success: boolean;
  now: Date;
}): string {
  const status = input.success
    ? 'urn:oasis:names:tc:SAML:2.0:status:Success'
    : 'urn:oasis:names:tc:SAML:2.0:status:Requester';
  return (
    `<samlp:LogoutResponse xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${newId()}" Version="2.0" IssueInstant="${instant(
      input.now,
    )}" Destination="${xmlAttr(input.destination)}" InResponseTo="${xmlAttr(input.inResponseTo)}">` +
    `<saml:Issuer>${xmlText(input.idpEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}"/></samlp:Status>` +
    `</samlp:LogoutResponse>`
  );
}

/** The auto-post form used for both logout directions on the POST binding. */
export function logoutPostForm(input: {
  destination: string;
  field: 'SAMLRequest' | 'SAMLResponse';
  xml: string;
  relayState: string | null;
}): string {
  const relay =
    input.relayState === null
      ? ''
      : `<input type="hidden" name="RelayState" value="${xmlAttr(input.relayState)}"/>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Signing you out</title></head>` +
    `<body onload="document.forms[0].submit()">` +
    `<form method="post" action="${xmlAttr(input.destination)}">` +
    `<input type="hidden" name="${input.field}" value="${xmlAttr(
      Buffer.from(input.xml, 'utf8').toString('base64'),
    )}"/>` +
    relay +
    `<noscript><button type="submit">Continue</button></noscript>` +
    `</form></body></html>`
  );
}

/**
 * The HTTP-Redirect form of a logout message: a URL to send the browser to.
 *
 * The message is DEFLATE-compressed with no zlib header, base64-encoded and
 * carried as a query parameter, which is the encoding SAML 2.0 Bindings
 * section 3.4.4.1 specifies and the mirror image of `decodeRedirectMessage`.
 *
 * Unsigned, like the POST-binding form beside it. A LogoutResponse says only
 * that a session Syntra had already ended is ended; a service provider that
 * requires a signature on one is a service provider this does not yet serve,
 * and the honest place to say so is the README rather than a signature that
 * looks right and covers the wrong bytes.
 *
 * Existing query parameters on the destination are preserved: a service
 * provider is entitled to register an endpoint that carries one, and
 * `URL.searchParams.set` keeps them where naive string concatenation would
 * produce two `?`.
 */
export function logoutRedirectUrl(input: {
  destination: string;
  field: 'SAMLRequest' | 'SAMLResponse';
  xml: string;
  relayState: string | null;
}): string {
  const url = new URL(input.destination);
  url.searchParams.set(
    input.field,
    deflateRawSync(Buffer.from(input.xml, 'utf8')).toString('base64'),
  );
  if (input.relayState !== null) url.searchParams.set('RelayState', input.relayState);
  return url.href;
}
