import { describe, expect, it } from 'vitest';
import { buildIdpMetadata } from '../saml/idp-metadata.js';
import {
  SIGN_IN,
  TOKEN_TYPE,
  buildRstr,
  parsePassiveRequest,
  passiveResponseForm,
} from './passive.js';

describe('parsePassiveRequest', () => {
  it('reads a sign-in', () => {
    expect(
      parsePassiveRequest({
        wa: 'wsignin1.0',
        wtrealm: 'https://rp.example.test/',
        wreply: 'https://rp.example.test/signin',
        wctx: 'rm=0&id=abc',
      }),
    ).toMatchObject({
      action: 'wsignin1.0',
      realm: 'https://rp.example.test/',
      reply: 'https://rp.example.test/signin',
      context: 'rm=0&id=abc',
    });
  });

  it('refuses a repeated parameter rather than picking one', () => {
    // `?wtrealm=a&wtrealm=b` is either an attack or a bug. Silently taking the
    // first is how a token gets issued for an audience nobody asked for, and
    // the handler turns a null realm into a refusal.
    expect(parsePassiveRequest({ wa: 'wsignin1.0', wtrealm: ['a', 'b'] }).realm).toBeNull();
  });

  it('treats blank and missing the same way', () => {
    expect(parsePassiveRequest({ wa: 'wsignin1.0', wreply: '   ' }).reply).toBeNull();
    expect(parsePassiveRequest({ wa: 'wsignin1.0' }).reply).toBeNull();
  });

  it('reads wfresh=0 as a demand to re-authenticate', () => {
    expect(parsePassiveRequest({ wa: 'wsignin1.0', wfresh: '0' }).freshnessMinutes).toBe(0);
  });

  it('does not read a malformed wfresh as zero', () => {
    // Zero means "re-authenticate now". Reading a mistyped value as zero would
    // let one bad link prompt everybody for a password they did not need to
    // give, on every application.
    expect(parsePassiveRequest({ wa: 'wsignin1.0', wfresh: 'soon' }).freshnessMinutes).toBeNull();
    expect(parsePassiveRequest({ wa: 'wsignin1.0', wfresh: '-1' }).freshnessMinutes).toBeNull();
    expect(parsePassiveRequest({ wa: 'wsignin1.0' }).freshnessMinutes).toBeNull();
  });
});

describe('buildRstr', () => {
  const rstr = () =>
    buildRstr({
      assertion: '<saml:Assertion ID="_1">signed</saml:Assertion>',
      realm: 'https://rp.example.test/',
      notBefore: new Date('2026-08-26T09:00:00.123Z'),
      notOnOrAfter: new Date('2026-08-26T09:05:00.000Z'),
    });

  it('wraps the assertion in a collection, which is what WIF requires', () => {
    // A bare RequestSecurityTokenResponse works against some stacks and fails
    // against .NET. The collection works everywhere.
    const xml = rstr();
    expect(xml).toContain('<t:RequestSecurityTokenResponseCollection');
    expect(xml).toContain('<t:RequestedSecurityToken><saml:Assertion ID="_1">');
  });

  it('names the realm as the audience the token applies to', () => {
    expect(rstr()).toContain('<wsa:Address>https://rp.example.test/</wsa:Address>');
  });

  it('advertises the token type it actually issues', () => {
    // SAML 2.0, not 1.1. A relying party configured for 1.1 must be told, not
    // handed a token it cannot read.
    expect(rstr()).toContain(`<t:TokenType>${TOKEN_TYPE}</t:TokenType>`);
    expect(TOKEN_TYPE).toBe('urn:oasis:names:tc:SAML:2.0:assertion');
  });

  it('drops the fractional second some parsers choke on', () => {
    expect(rstr()).toContain('<wsu:Created');
    expect(rstr()).toContain('2026-08-26T09:00:00Z');
    expect(rstr()).not.toContain('.123Z');
  });
});

describe('passiveResponseForm', () => {
  it('posts the result and echoes the context', () => {
    const html = passiveResponseForm({
      reply: 'https://rp.example.test/signin',
      result: '<t:X/>',
      context: 'rm=0',
    });
    expect(html).toContain('action="https://rp.example.test/signin"');
    expect(html).toContain(`name="wa" value="${SIGN_IN}"`);
    expect(html).toContain('name="wctx" value="rm=0"');
  });

  it('omits wctx entirely when the relying party sent none', () => {
    // An empty `wctx` is not the same as no `wctx`, and some relying parties
    // treat one as a state they never issued.
    const html = passiveResponseForm({
      reply: 'https://rp.example.test/signin',
      result: '<t:X/>',
      context: null,
    });
    expect(html).not.toContain('wctx');
  });

  it('escapes a context that tries to close the attribute', () => {
    // `wctx` is chosen by whoever composed the link, and this is a page the
    // browser is about to render with a bearer token on it.
    const html = passiveResponseForm({
      reply: 'https://rp.example.test/signin',
      result: '<t:X/>',
      context: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('escapes a reply URL the same way', () => {
    const html = passiveResponseForm({
      reply: 'https://rp.example.test/a"onload="x',
      result: '<t:X/>',
      context: null,
    });
    expect(html).not.toContain('"onload="x');
  });

  it('still submits without script', () => {
    // A form that only submits from script is a sign-in that fails silently
    // under a strict content policy.
    const html = passiveResponseForm({
      reply: 'https://rp.example.test/signin',
      result: '<t:X/>',
      context: null,
    });
    expect(html).toContain('type="submit"');
  });
});

describe('the WS-Federation role in IdP metadata', () => {
  const metadata = (wsFedUrl: string | null) =>
    buildIdpMetadata({
      entityId: 'https://idp.example.test/saml/idp',
      ssoUrl: 'https://idp.example.test/saml/sso',
      sloUrl: 'https://idp.example.test/saml/slo',
      nameIdFormats: [],
      certificates: ['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'],
      wsFedUrl,
    });

  it('publishes the role .NET actually looks for', () => {
    // `WsFederationConfigurationRetriever` reads exactly this element. An
    // IDPSSODescriptor on its own means "no WS-Fed here" to it, however
    // willing the endpoint is.
    const xml = metadata('https://idp.example.test/saml/wsfed');
    expect(xml).toContain('xsi:type="fed:SecurityTokenServiceType"');
    expect(xml).toContain('<fed:PassiveRequestorEndpoint>');
    expect(xml).toContain('<wsa:Address>https://idp.example.test/saml/wsfed</wsa:Address>');
  });

  it('carries the same signing certificate as the SAML role', () => {
    // One identity provider speaking a second protocol, not a second one. A
    // relying party that fetched a different key here would reject every
    // token.
    const xml = metadata('https://idp.example.test/saml/wsfed');
    expect(xml.match(/<ds:X509Certificate>AAAA<\/ds:X509Certificate>/g)).toHaveLength(2);
  });

  it('says nothing at all when no application accepts WS-Federation', () => {
    // Advertising the endpoint anyway invites a relying party to configure
    // itself against a door that answers 404 for every realm.
    const xml = metadata(null);
    expect(xml).not.toContain('SecurityTokenServiceType');
    expect(xml).toContain('IDPSSODescriptor');
  });
});
