import { xmlAttr, xmlText } from '../xml/escape.js';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
export const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
export const BINDING_REDIRECT =
  'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/**
 * SAML metadata carries the DER bytes, base64, with no PEM armour and no line
 * breaks. A certificate pasted in with its armour intact is the single most
 * common reason an SP rejects an IdP's metadata, and the failure at the far
 * end is an opaque parse error.
 */
export function derBody(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

export interface IdpMetadataInput {
  entityId: string;
  ssoUrl: string;
  sloUrl: string;
  nameIdFormats: string[];
  /** PEM certificates, active first. Every published key appears. */
  certificates: string[];
}

/**
 * The IdP EntityDescriptor a service provider imports.
 *
 * Every key from `publishedKeys` appears as its own KeyDescriptor, which is
 * what makes a rollover survivable for an SP that fetches metadata: during the
 * overlap it sees both, and an assertion signed with either verifies.
 *
 * The document is not itself signed. Signed metadata is worth having and is
 * out of scope for this slice; what stands in for it is that the document is
 * served over TLS from the tenant's own host, which Task 2's
 * `assertProtocolHost` enforces.
 */
export function buildIdpMetadata(input: IdpMetadataInput): string {
  const keys = input.certificates
    .map(
      (pem) =>
        `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${DS}"><ds:X509Data><ds:X509Certificate>${xmlText(
          derBody(pem),
        )}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join('');

  const formats = input.nameIdFormats
    .map((f) => `<md:NameIDFormat>${xmlText(f)}</md:NameIDFormat>`)
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<md:EntityDescriptor xmlns:md="${MD}" entityID="${xmlAttr(input.entityId)}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">` +
    keys +
    `<md:SingleLogoutService Binding="${BINDING_REDIRECT}" Location="${xmlAttr(input.sloUrl)}"/>` +
    `<md:SingleLogoutService Binding="${BINDING_POST}" Location="${xmlAttr(input.sloUrl)}"/>` +
    formats +
    // Redirect first, then POST: spec section 7 requires both, and an SP that
    // takes the first offered binding gets the one that survives a browser's
    // URL length limits least badly for a request and best for a response.
    `<md:SingleSignOnService Binding="${BINDING_REDIRECT}" Location="${xmlAttr(input.ssoUrl)}"/>` +
    `<md:SingleSignOnService Binding="${BINDING_POST}" Location="${xmlAttr(input.ssoUrl)}"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`
  );
}
