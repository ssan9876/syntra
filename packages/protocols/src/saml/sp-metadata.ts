import { isProtocolEndpoint } from '@syntra/contracts';
import { parseXml, selectElements } from '../xml/parse.js';

export interface ParsedSpMetadata {
  entityId: string;
  acsUrls: string[];
  /** The SP's own `isDefault` entry, or its first, and always on `acsUrls`. */
  defaultAcsUrl: string;
  sloUrl: string | null;
  wantAssertionsSigned: boolean;
  /**
   * The certificates this service provider signs with. PEM, armour restored.
   *
   * Signing only: a `KeyDescriptor use="encryption"` is excluded. Trusting an
   * encryption-only certificate for AuthnRequest signature verification is
   * accepting a signature from a key the SP declared it does not sign with,
   * and `use` is the only thing in the document that says which is which.
   */
  certificates: string[];
  /**
   * The certificates this service provider is encrypted to. Kept apart for
   * the same reason: the two roles are not interchangeable, and a document
   * that separates them must not be flattened back together here.
   */
  encryptionCertificates: string[];
  nameIdFormats: string[];
}

const pem = (body: string) =>
  `-----BEGIN CERTIFICATE-----\n${
    body.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? ''
  }\n-----END CERTIFICATE-----\n`;

/**
 * Reads an uploaded or fetched service-provider EntityDescriptor.
 *
 * Every value here becomes configuration a later assertion is checked
 * against, so this is untrusted input in the strongest sense: an
 * administrator talked into importing one file must not end up with a
 * `javascript:` ACS URL on the allowlist, which is why each location is put
 * through `isProtocolEndpoint` before it is kept. Metadata with no usable ACS
 * URL throws rather than producing an empty allowlist, because an empty
 * allowlist is a configuration that silently fails every login later, at a
 * point nobody connects to the import.
 *
 * Parsed through `parseXml`, so entity expansion is off here as it is
 * everywhere else.
 */
export function parseSpMetadata(xml: string): ParsedSpMetadata {
  const doc = parseXml(xml);

  const entityId =
    doc.documentElement?.getAttribute('entityID')?.trim() ?? '';
  if (entityId === '') throw new Error('metadata has no entityID');

  const descriptors = selectElements(
    doc,
    "//*[local-name(.)='SPSSODescriptor']",
  );
  if (descriptors.length === 0) {
    throw new Error('metadata contains no SPSSODescriptor');
  }
  const sp = descriptors[0]!;

  const acsNodes = selectElements(
    sp,
    ".//*[local-name(.)='AssertionConsumerService']",
  ).filter((e) => isProtocolEndpoint(e.getAttribute('Location') ?? ''));

  const acsUrls = acsNodes.map((e) => e.getAttribute('Location')!);

  if (acsUrls.length === 0) {
    throw new Error(
      'metadata contains no usable assertion consumer service URL',
    );
  }

  // The service provider's own choice, when it made one. `resolveAcsUrl` has
  // no implicit fallback, so this is what an unsolicited assertion uses, and
  // reading it from the document rather than from list order is what keeps a
  // re-import from silently moving it.
  const defaultAcsUrl =
    acsNodes.find((e) => e.getAttribute('isDefault') === 'true')?.getAttribute('Location') ??
    acsUrls[0]!;

  const sloUrl =
    selectElements(sp, ".//*[local-name(.)='SingleLogoutService']")
      .map((e) => e.getAttribute('Location') ?? '')
      .find((url) => isProtocolEndpoint(url)) ?? null;

  // Per role, never flattened. A `KeyDescriptor` with no `use` serves both,
  // which is what the metadata schema says an omitted `use` means; one that
  // names a role serves only that role. Certificates that sit outside any
  // `KeyDescriptor` are ignored rather than swept into the signing set —
  // that placement is not what the schema allows, and the safe reading of an
  // ambiguous document is the narrower one.
  const keyDescriptors = selectElements(sp, ".//*[local-name(.)='KeyDescriptor']");
  const certificatesFor = (role: 'signing' | 'encryption') =>
    keyDescriptors
      .filter((kd) => {
        const use = (kd.getAttribute('use') ?? '').trim();
        return use === '' || use === role;
      })
      .flatMap((kd) => selectElements(kd, ".//*[local-name(.)='X509Certificate']"))
      .map((e) => (e.textContent ?? '').trim())
      .filter((body) => body !== '')
      .map(pem);

  const certificates = certificatesFor('signing');
  const encryptionCertificates = certificatesFor('encryption');

  const nameIdFormats = selectElements(sp, ".//*[local-name(.)='NameIDFormat']")
    .map((e) => (e.textContent ?? '').trim())
    .filter((f) => f !== '');

  return {
    entityId,
    acsUrls,
    defaultAcsUrl,
    sloUrl,
    // Absent means false per the schema default, but a service provider that
    // said nothing is one whose assertions Syntra signs anyway — Syntra always
    // signs. This flag only records what the SP asked for.
    wantAssertionsSigned: sp.getAttribute('WantAssertionsSigned') === 'true',
    certificates,
    encryptionCertificates,
    nameIdFormats,
  };
}
