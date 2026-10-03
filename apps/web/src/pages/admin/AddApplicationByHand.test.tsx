import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AddApplicationByHand } from './AddApplicationByHand.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as never;

function mockApi(answer: (body: Record<string, unknown>) => Response) {
  const sent: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/claim-sets')) {
      return Promise.resolve(json({ sets: [{ id: 'set-1', name: 'Employee id', protocol: 'saml' }] }));
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push(body);
    return Promise.resolve(answer(body));
  });
  return sent;
}

const renderForm = (onCreated = vi.fn()) =>
  render(
    <MemoryRouter>
      <AddApplicationByHand onCancel={() => undefined} onCreated={onCreated} />
    </MemoryRouter>,
  );

afterEach(() => vi.restoreAllMocks());

describe('AddApplicationByHand', () => {
  it('sends a SAML application typed in, with a saved claim set', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const sent = mockApi(() => json({ applicationId: 'a1', slug: 'payroll', name: 'Payroll', protocol: 'saml' }, 201));
    renderForm(onCreated);

    await user.type(screen.getByLabelText(/^name$/i), 'Payroll');
    await user.selectOptions(screen.getByLabelText(/^sign-in$/i), 'saml');
    await user.selectOptions(screen.getByLabelText(/settings from/i), 'manual');
    await user.type(screen.getByLabelText(/^entity id$/i), 'https://payroll.example.test');
    await user.type(screen.getByLabelText(/acs urls/i), 'https://payroll.example.test/acs');
    await user.type(screen.getByLabelText(/signing certificate/i), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
    await user.selectOptions(await screen.findByLabelText(/^claims$/i), 'set-1');
    await user.click(screen.getByRole('button', { name: /save application/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(sent[0]).toEqual({
      name: 'Payroll',
      protocol: 'saml',
      saml: {
        spEntityId: 'https://payroll.example.test',
        acsUrls: ['https://payroll.example.test/acs'],
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        spCertificates: ['-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'],
        wantAuthnRequestsSigned: true,
      },
      claims: { kind: 'set', setId: 'set-1' },
    });
  });

  it('shows an OpenID Connect client secret once', async () => {
    const user = userEvent.setup();
    const sent = mockApi(() =>
      json({ applicationId: 'a2', slug: 'grafana', name: 'Grafana', protocol: 'oidc', clientId: 'grafana-1a2b', clientSecret: 's3cret' }, 201),
    );
    renderForm();

    await user.type(screen.getByLabelText(/^name$/i), 'Grafana');
    await user.selectOptions(screen.getByLabelText(/^sign-in$/i), 'oidc');
    await user.type(screen.getByLabelText(/launch url/i), 'https://grafana.example.test');
    await user.type(screen.getByLabelText(/redirect uris/i), 'https://grafana.example.test/login/generic_oauth');
    await user.click(screen.getByRole('button', { name: /save application/i }));

    expect(await screen.findByText('Shown once — copy it now.')).toBeInTheDocument();
    expect(screen.getByLabelText(/client secret/i)).toHaveValue('s3cret');
    expect(sent[0]).toMatchObject({
      protocol: 'oidc',
      oidc: { redirectUris: ['https://grafana.example.test/login/generic_oauth'], scopes: ['openid', 'profile', 'email'] },
      claims: { kind: 'standard' },
    });
  });

  it('marks the field the server refused', async () => {
    const user = userEvent.setup();
    mockApi(() =>
      json(
        {
          type: 'about:blank',
          title: 'Slug already in use',
          status: 409,
          errors: [{ path: 'slug', message: 'Slug wiki is already in use.' }],
        },
        409,
      ),
    );
    renderForm();

    await user.type(screen.getByLabelText(/^name$/i), 'Wiki');
    await user.type(screen.getByLabelText(/^slug$/i), 'wiki');
    await user.type(screen.getByLabelText(/launch url/i), 'https://wiki.example.test');
    await user.click(screen.getByRole('button', { name: /save application/i }));

    expect(await screen.findAllByText('Slug wiki is already in use.')).not.toHaveLength(0);
  });
});
