import { describe, expect, it } from 'vitest';
import { buildIdpMetadata } from './idp-metadata.js';
import { parseSpMetadata } from './sp-metadata.js';
import { parseXml, selectElements } from '../xml/parse.js';

const CERT_BODY =
  'MIIByjCCATOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlsb2NhbGhvc3Q=';

describe('buildIdpMetadata', () => {
  const xml = buildIdpMetadata({
    entityId: 'https://sso.acme.test/saml/idp',
    ssoUrl: 'https://sso.acme.test/saml/sso',
    sloUrl: 'https://sso.acme.test/saml/slo',
    nameIdFormats: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
    certificates: [
      `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n-----END CERTIFICATE-----\n`,
    ],
  });

  it('is well-formed and names the entity', () => {
    const doc = parseXml(xml);
    expect(doc.documentElement!.getAttribute('entityID')).toBe(
      'https://sso.acme.test/saml/idp',
    );
  });

  it('publishes both bindings for single sign-on', () => {
    const doc = parseXml(xml);
    const sso = selectElements(
      doc,
      "//*[local-name(.)='SingleSignOnService']",
    ).map((e) => e.getAttribute('Binding'));
    expect(sso).toEqual([
      'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
      'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
    ]);
  });

  it('strips the PEM armour from the certificate, as SAML metadata requires', () => {
    const doc = parseXml(xml);
    const [cert] = selectElements(doc, "//*[local-name(.)='X509Certificate']");
    expect(cert!.textContent).toBe(CERT_BODY);
    expect(xml).not.toContain('BEGIN CERTIFICATE');
  });

  it('publishes every key it is given, so a rollover is visible to a service provider', () => {
    const two = buildIdpMetadata({
      entityId: 'https://sso.acme.test/saml/idp',
      ssoUrl: 'https://sso.acme.test/saml/sso',
      sloUrl: 'https://sso.acme.test/saml/slo',
      nameIdFormats: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
      certificates: [
        `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n-----END CERTIFICATE-----`,
        `-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----`,
      ],
    });
    const doc = parseXml(two);
    expect(
      selectElements(doc, "//*[local-name(.)='KeyDescriptor']"),
    ).toHaveLength(2);
  });

  it('escapes a hostile entity id rather than emitting it raw', () => {
    const hostile = buildIdpMetadata({
      entityId: 'https://a.test/"><evil x="',
      ssoUrl: 'https://a.test/sso',
      sloUrl: 'https://a.test/slo',
      nameIdFormats: [],
      certificates: [],
    });
    expect(hostile).not.toContain('<evil');
    expect(() => parseXml(hostile)).not.toThrow();
  });
});

describe('parseSpMetadata', () => {
  const sp = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example.test/metadata">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${CERT_BODY}</X509Certificate></X509Data></KeyInfo>
    </KeyDescriptor>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/slo"/>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService index="0" isDefault="true" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs"/>
    <AssertionConsumerService index="1" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs2"/>
  </SPSSODescriptor>
</EntityDescriptor>`;

  it('reads the entity id, both ACS URLs, the SLO URL and the certificate', () => {
    const parsed = parseSpMetadata(sp);
    expect(parsed.entityId).toBe('https://sp.example.test/metadata');
    expect(parsed.acsUrls).toEqual([
      'https://sp.example.test/acs',
      'https://sp.example.test/acs2',
    ]);
    // The SP marked the first one isDefault. `resolveAcsUrl` has no implicit
    // fallback, so this is the value an unsolicited assertion is delivered to
    // and it has to come from the document rather than from list order.
    expect(parsed.defaultAcsUrl).toBe('https://sp.example.test/acs');
    expect(parsed.sloUrl).toBe('https://sp.example.test/slo');
    expect(parsed.wantAssertionsSigned).toBe(true);
    expect(parsed.certificates[0]).toContain('BEGIN CERTIFICATE');
    // `pem()` line-wraps at 64 characters per RFC 7468, and this fixture's
    // body is 72 characters, so a straight substring check would split across
    // the inserted newline. Compare with whitespace collapsed instead.
    expect(parsed.certificates[0]!.replace(/\s+/g, '')).toContain(CERT_BODY);
  });

  it('honours isDefault rather than document order when picking the default', () => {
    // Move isDefault to the second entry and leave the order alone. An
    // implementation that returned acsUrls[0] passes the case above and fails
    // this one.
    const moved = sp
      .replace(' index="0" isDefault="true"', ' index="0"')
      .replace(' index="1"', ' index="1" isDefault="true"');
    expect(parseSpMetadata(moved).defaultAcsUrl).toBe('https://sp.example.test/acs2');
  });

  it('drops an ACS URL that is not an http(s) endpoint', () => {
    // An uploaded metadata file is attacker-controlled input the moment an
    // administrator is talked into importing one. A javascript: ACS URL that
    // reached the allowlist would be a stored redirect into script.
    const hostile = sp.replace(
      'https://sp.example.test/acs2',
      'javascript:alert(1)',
    );
    expect(parseSpMetadata(hostile).acsUrls).toEqual([
      'https://sp.example.test/acs',
    ]);
  });

  it('refuses metadata with no ACS URL at all rather than storing an empty allowlist', () => {
    const none = sp.replace(/<AssertionConsumerService[\s\S]*?\/>/g, '');
    expect(() => parseSpMetadata(none)).toThrow(/assertion consumer service/i);
  });

  it('does not expand an entity smuggled into metadata', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE EntityDescriptor [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>
${sp.replace('https://sp.example.test/metadata', '&x;').replace(/^<\?xml[^>]*\?>\n/, '')}`;
    expect(parseSpMetadata(xxe).entityId).not.toContain('root:');
  });
});
