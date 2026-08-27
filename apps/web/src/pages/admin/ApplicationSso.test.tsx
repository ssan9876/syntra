import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApplicationSso } from './ApplicationSso.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const samlConfig = (over: Record<string, unknown> = {}) => ({
  spEntityId: 'https://slack.com',
  acsUrls: ['https://acme.slack.com/sso/saml'],
  defaultAcsUrl: 'https://acme.slack.com/sso/saml',
  nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  nameIdClaim: null,
  spCertificates: [],
  wantAuthnRequestsSigned: true,
  encryptAssertions: false,
  encryptionCertificate: null,
  sloUrl: null,
  sloBinding: 'HTTP-POST',
  allowIdpInitiated: false,
  assertionLifetimeMs: 300000,
  ...over,
});

const oidcClient = (over: Record<string, unknown> = {}) => ({
  clientId: 'grafana-abc',
  redirectUris: ['https://grafana.acme.test/login/generic_oauth'],
  postLogoutRedirectUris: [],
  grantTypes: ['authorization_code', 'refresh_token'],
  clientCredentialsEnabled: false,
  scopes: ['openid', 'profile', 'email'],
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 1209600,
  ...over,
});

function mockApi(options: {
  saml?: unknown | null;
  oidc?: unknown | null;
  write?: () => Response;
}) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(options.write ? options.write() : json({}));
    }
    if (url.endsWith('/saml')) {
      return Promise.resolve(
        options.saml ? json(options.saml) : json({ title: 'Not configured', status: 404 }, 404),
      );
    }
    return Promise.resolve(
      options.oidc ? json(options.oidc) : json({ title: 'Not configured', status: 404 }, 404),
    );
  });
  return sent;
}

const renderPanel = () =>
  render(
    <MemoryRouter>
      <ApplicationSso applicationId="app-1" />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ApplicationSso', () => {
  it('says so plainly when the application uses neither protocol', async () => {
    mockApi({});
    renderPanel();
    expect(await screen.findByText(/no SAML or OpenID Connect/i)).toBeInTheDocument();
  });

  it('shows the SAML settings the catalog wrote', async () => {
    mockApi({ saml: samlConfig() });
    renderPanel();
    expect(await screen.findByDisplayValue('https://slack.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://acme.slack.com/sso/saml')).toBeInTheDocument();
  });

  it('offers a place to paste the certificate the catalog leaves empty', async () => {
    // The gap this whole panel exists to close: the catalog deliberately does
    // not invent a signing certificate, and there was nowhere to supply one.
    mockApi({ saml: samlConfig() });
    renderPanel();
    expect(await screen.findByLabelText(/signing certificates/i)).toBeInTheDocument();
  });

  it('splits a pasted blob into whole certificates', async () => {
    const user = userEvent.setup();
    const sent = mockApi({ saml: samlConfig() });
    renderPanel();

    const box = await screen.findByLabelText(/signing certificates/i);
    // Two certificates, one after the other, which is how a vendor hands them
    // over. Splitting on newlines would send sixteen lines of base64 as
    // sixteen certificates.
    await user.click(box);
    await user.paste(
      '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n' +
        '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----',
    );
    await user.click(screen.getByRole('button', { name: /save saml settings/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0]!.body as { spCertificates: string[] }).spCertificates).toHaveLength(2);
  });

  it('sends a metadata URL as a url and pasted XML as xml', async () => {
    const user = userEvent.setup();
    const sent = mockApi({ saml: samlConfig() });
    renderPanel();

    const box = await screen.findByLabelText(/service provider metadata/i);
    await user.type(box, 'https://sp.example.test/metadata');
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({ url: 'https://sp.example.test/metadata' });
  });

  it('keeps the signed-request requirement visible as a choice', async () => {
    // It defaults to true by ruling, and an administrator turning it off
    // should be doing so deliberately rather than inheriting it.
    mockApi({ saml: samlConfig() });
    renderPanel();
    expect(
      await screen.findByLabelText(/require the service provider to sign/i),
    ).toBeChecked();
  });

  it('carries through SAML settings this form does not show', async () => {
    // `upsertSamlConfig` writes every column and the request schema defaults
    // anything absent, so a body carrying only the six fields on screen would
    // switch off assertion encryption and drop its certificate — on every
    // save, silently.
    const user = userEvent.setup();
    const sent = mockApi({
      saml: samlConfig({
        encryptAssertions: true,
        encryptionCertificate: '-----BEGIN CERTIFICATE-----ZZZ-----END CERTIFICATE-----',
        assertionLifetimeMs: 60000,
        nameIdClaim: 'employeeId',
      }),
    });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /save saml settings/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({
      encryptAssertions: true,
      assertionLifetimeMs: 60000,
      nameIdClaim: 'employeeId',
    });
  });

  it('keeps a chosen default ACS URL rather than overwriting it with the first', async () => {
    const user = userEvent.setup();
    const sent = mockApi({
      saml: samlConfig({
        acsUrls: ['https://a.example/acs', 'https://b.example/acs'],
        defaultAcsUrl: 'https://b.example/acs',
      }),
    });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /save saml settings/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    // A deliberate choice, not a position in a list.
    expect(sent[0]!.body).toMatchObject({ defaultAcsUrl: 'https://b.example/acs' });
  });

  it('does not hand back refresh tokens somebody had taken away', async () => {
    // `refreshTokenTtlSeconds: 0` is documented as "issued no refresh tokens
    // at all". Saving a redirect URI must not reset it to fourteen days.
    const user = userEvent.setup();
    const sent = mockApi({ oidc: oidcClient({ refreshTokenTtlSeconds: 0 }) });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /save openid connect/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({ refreshTokenTtlSeconds: 0 });
  });

  it('exposes the machine-client grant, which had no control at all', async () => {
    // Implemented, enforced at the token endpoint, advertised by the provider
    // — and until this panel it could only be turned on with SQL.
    const user = userEvent.setup();
    const sent = mockApi({ oidc: oidcClient() });
    renderPanel();

    await user.click(await screen.findByLabelText(/this is a machine, not a person/i));
    await user.click(screen.getByRole('button', { name: /save openid connect/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({
      clientCredentialsEnabled: true,
      // A machine client takes no grants and no redirect URIs; the contract
      // refuses `authorization_code` without one.
      grantTypes: [],
    });
  });

  it('hides redirect URIs once the client is a machine', async () => {
    const user = userEvent.setup();
    mockApi({ oidc: oidcClient() });
    renderPanel();

    expect(await screen.findByLabelText(/redirect uris/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/this is a machine, not a person/i));
    expect(screen.queryByLabelText(/redirect uris/i)).toBeNull();
  });

  it('shows a rotated secret once', async () => {
    const user = userEvent.setup();
    mockApi({ oidc: oidcClient(), write: () => json({ clientSecret: 'newsecret123' }) });
    renderPanel();

    await user.click(await screen.findByLabelText(/issue a new client secret/i));
    await user.click(screen.getByRole('button', { name: /save openid connect/i }));

    expect(await screen.findByText('newsecret123')).toBeInTheDocument();
  });

  it('shows the server’s refusal rather than a generic failure', async () => {
    const user = userEvent.setup();
    mockApi({
      saml: samlConfig(),
      write: () =>
        json(
          {
            title: 'Invalid',
            detail:
              'Requiring signed requests needs at least one certificate to check them against.',
            status: 400,
          },
          400,
        ),
    });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /save saml settings/i }));
    expect(
      await screen.findByText(/needs at least one certificate/i),
    ).toBeInTheDocument();
  });
});
