import { xmlAttr, xmlText } from '../xml/escape.js';

/**
 * WS-Federation, passive requestor profile.
 *
 * The protocol every .NET application built before OIDC speaks, and the reason
 * this exists: an organization migrating away from ADFS has a SharePoint, a
 * line-of-business web app and something a vendor wrote in 2014, and none of
 * them will be rewritten because the identity provider changed. Without this
 * they keep ADFS running alongside Syntra, which means they have two identity
 * providers and one of them is the one nobody is maintaining.
 *
 * The whole protocol is query parameters on a GET and one auto-posted form
 * back. There is no request signature to verify, no artifact, and no
 * back-channel — which is precisely why `wreply` is checked against registered
 * URLs rather than trusted: an unchecked `wreply` is an open redirect that
 * carries a bearer token in its body.
 *
 * **The token is a SAML 2.0 assertion, not SAML 1.1.** Classic ADFS issued 1.1
 * by default and some very old relying parties accept nothing else; those are
 * not supported and should be told so rather than left to fail against a token
 * they cannot read. Everything built on WIF or `Microsoft.Owin.Security.
 * WsFederation` reads 2.0 when its `tokenType` is set accordingly, which is
 * what `TOKEN_TYPE` below advertises.
 */

/** The `wa` values this endpoint answers. Anything else is refused. */
export const SIGN_IN = 'wsignin1.0';
export const SIGN_OUT = 'wsignout1.0';
export const SIGN_OUT_CLEANUP = 'wsignoutcleanup1.0';

/** SAML 2.0, as named in the WS-Trust token type registry. */
export const TOKEN_TYPE = 'urn:oasis:names:tc:SAML:2.0:assertion';

const WST_NS = 'http://docs.oasis-open.org/ws-sx/ws-trust/200512';
const WSA_NS = 'http://www.w3.org/2005/08/addressing';
const WSP_NS = 'http://schemas.xmlsoap.org/ws/2004/09/policy';

export interface PassiveRequest {
  /** `wsignin1.0`, `wsignout1.0` or `wsignoutcleanup1.0`. */
  action: string;
  /** The relying party's realm — the WS-Fed equivalent of an SP entity ID. */
  realm: string | null;
  /** Where to post the token. Null means "the registered default". */
  reply: string | null;
  /**
   * Opaque state the relying party asked to have handed back.
   *
   * Echoed verbatim and never interpreted. It is also never used to decide
   * where anything goes: a `wctx` carrying a URL is still just a string here,
   * because the destination comes from `wreply` checked against registration.
   */
  context: string | null;
  /**
   * `wfresh=0` means the relying party wants the user re-authenticated now,
   * whatever session they already hold.
   *
   * Parsed as a number of MINUTES, which is what the specification says, and
   * treated as a maximum age. Anything unparseable is null rather than zero —
   * reading a malformed value as "force re-authentication" would let a
   * mistyped link log everybody out of everything.
   */
  freshnessMinutes: number | null;
  /** A home realm hint. Advisory; the policy engine decides routing. */
  homeRealm: string | null;
}

export function parsePassiveRequest(query: Record<string, unknown>): PassiveRequest {
  const str = (key: string): string | null => {
    const value = query[key];
    // A repeated parameter arrives as an array. Refused rather than
    // first-wins: `?wtrealm=a&wtrealm=b` is either an attack or a bug, and
    // silently choosing one of the two realms is how a token is issued for an
    // audience nobody asked for.
    if (Array.isArray(value)) return null;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  const freshness = str('wfresh');
  const parsed = freshness === null ? Number.NaN : Number.parseInt(freshness, 10);

  return {
    action: str('wa') ?? '',
    realm: str('wtrealm'),
    reply: str('wreply'),
    context: str('wctx'),
    freshnessMinutes: Number.isInteger(parsed) && parsed >= 0 ? parsed : null,
    homeRealm: str('whr'),
  };
}

export interface RstrInput {
  /** The signed `<saml:Assertion>`, built by the SAML assertion builder. */
  assertion: string;
  realm: string;
  /** When the token becomes valid, and when it stops being. */
  notBefore: Date;
  notOnOrAfter: Date;
}

/** WS-Fed wants seconds, like SAML; a fractional part upsets some parsers. */
const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The `RequestSecurityTokenResponse` that carries the assertion.
 *
 * Wrapped in a `Collection` — `RequestSecurityTokenResponseCollection` — which
 * WIF requires and which several other stacks accept either way. Emitting the
 * bare RSTR works against some relying parties and fails against .NET, so the
 * collection is the form that works everywhere.
 *
 * Nothing here is signed. The signature is on the assertion INSIDE it, which
 * is what the relying party validates; signing the envelope as well would add
 * a second signature no implementation checks.
 */
export function buildRstr(input: RstrInput): string {
  return (
    `<t:RequestSecurityTokenResponseCollection xmlns:t="${WST_NS}">` +
    `<t:RequestSecurityTokenResponse>` +
    `<t:Lifetime>` +
    `<wsu:Created xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${instant(
      input.notBefore,
    )}</wsu:Created>` +
    `<wsu:Expires xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${instant(
      input.notOnOrAfter,
    )}</wsu:Expires>` +
    `</t:Lifetime>` +
    `<wsp:AppliesTo xmlns:wsp="${WSP_NS}">` +
    `<wsa:EndpointReference xmlns:wsa="${WSA_NS}">` +
    `<wsa:Address>${xmlText(input.realm)}</wsa:Address>` +
    `</wsa:EndpointReference>` +
    `</wsp:AppliesTo>` +
    `<t:RequestedSecurityToken>${input.assertion}</t:RequestedSecurityToken>` +
    `<t:TokenType>${TOKEN_TYPE}</t:TokenType>` +
    `<t:RequestType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/Issue</t:RequestType>` +
    `<t:KeyType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/Bearer</t:KeyType>` +
    `</t:RequestSecurityTokenResponse>` +
    `</t:RequestSecurityTokenResponseCollection>`
  );
}

/**
 * The auto-posted form that delivers the RSTR.
 *
 * `wresult` carries the XML and `wctx` carries the relying party's state back
 * unchanged. Both are escaped as attribute values — an unescaped `wctx` is an
 * HTML injection into a page the browser is about to render, on a form
 * carrying a bearer token.
 *
 * The submit button is there for the seconds before the script runs, and for
 * anybody whose browser will not run it. A form that only submits from script
 * is a sign-in that fails silently under a strict content policy.
 */
export function passiveResponseForm(input: {
  reply: string;
  result: string;
  context: string | null;
}): string {
  const contextField =
    input.context === null
      ? ''
      : `<input type="hidden" name="wctx" value="${xmlAttr(input.context)}"/>`;

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Signing in</title></head>` +
    `<body onload="document.forms[0].submit()">` +
    `<noscript><p>Your browser does not run scripts. Press the button to continue.</p></noscript>` +
    `<form method="post" action="${xmlAttr(input.reply)}">` +
    `<input type="hidden" name="wa" value="${SIGN_IN}"/>` +
    `<input type="hidden" name="wresult" value="${xmlAttr(input.result)}"/>` +
    contextField +
    `<input type="submit" value="Continue"/>` +
    `</form></body></html>`
  );
}
