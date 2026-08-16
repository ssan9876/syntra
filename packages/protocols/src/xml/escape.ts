/**
 * Characters XML 1.0 cannot carry in content at all. A display name pulled
 * from LDAP can hold them, and a document containing one aborts the parse at
 * the far end with an error the tenant cannot act on.
 */
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

const escape = (value: string) =>
  value.replace(ILLEGAL, '').replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/**
 * Escapes a value going into element content.
 *
 * Every value the SAML builder interpolates goes through this or `xmlAttr`.
 * The assertion is built as a string rather than through a DOM because it must
 * be byte-stable for canonicalization, and a string builder with an
 * un-escaped interpolation is XML injection — a display name of
 * `</saml:AttributeValue><saml:AttributeValue>admin` would otherwise add an
 * attribute value the administrator never mapped.
 */
export const xmlText = escape;

/** Escapes a value going into an attribute. Same rules; named for the sink. */
export const xmlAttr = escape;
