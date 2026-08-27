import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApplicationsPage } from './ApplicationsPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const slack = {
  key: 'slack',
  name: 'Slack',
  category: 'collaboration',
  description: 'Team messaging. One entry per Slack workspace.',
  docsUrl: 'https://slack.com/help/articles/205168057',
  variables: [
    {
      key: 'workspace',
      label: 'Workspace subdomain',
      example: 'acme',
      hint: 'The part before .slack.com',
    },
  ],
  saml: {},
};

const grafana = {
  key: 'grafana',
  name: 'Grafana',
  category: 'engineering',
  description: 'Dashboards, through its generic OAuth provider.',
  docsUrl: 'https://grafana.com/docs',
  variables: [{ key: 'host', label: 'Grafana hostname', example: 'grafana.acme.example' }],
  oidc: {},
};

/** Answers the applications list, the catalog, and any write. */
function mockApi(post?: (body: unknown) => Response) {
  const sent: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      sent.push({ url, body });
      return Promise.resolve(post ? post(body) : json({}, 201));
    }
    if (url.includes('/api/admin/catalog')) {
      return Promise.resolve(json({ entries: [grafana, slack] }));
    }
    return Promise.resolve(json({ applications: [] }));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <ApplicationsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ApplicationsPage', () => {
  it('offers the catalog before the blank form', async () => {
    // Registering a known application by hand means transcribing four values
    // out of a vendor page, each of which fails at the first sign-in if it is
    // wrong. The catalog is the primary action for that reason.
    mockApi();
    renderPage();
    expect(
      await screen.findByRole('button', { name: /add from the catalog/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add by hand/i })).toBeInTheDocument();
  });

  it('asks only for the values that application needs', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add from the catalog/i }));
    await user.click(await screen.findByRole('button', { name: /slack/i }));

    // One field, because Slack needs one thing from the customer — not a page
    // of SAML settings greyed out because this vendor does not use them.
    expect(screen.getByLabelText(/workspace subdomain/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/entity id/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/acs url/i)).not.toBeInTheDocument();
  });

  it('sends the key and the values it collected', async () => {
    const user = userEvent.setup();
    const sent = mockApi(() => json({ applicationId: 'a1', slug: 'slack' }, 201));
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add from the catalog/i }));
    await user.click(await screen.findByRole('button', { name: /slack/i }));
    await user.type(screen.getByLabelText(/workspace subdomain/i), 'acme');
    await user.click(screen.getByRole('button', { name: /^add slack$/i }));

    await waitFor(() =>
      expect(sent[0]).toMatchObject({
        url: expect.stringContaining('/api/admin/applications/from-catalog'),
        body: { key: 'slack', variables: { workspace: 'acme' } },
      }),
    );
  });

  it('links the vendor page beside the fields it filled in', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add from the catalog/i }));
    await user.click(await screen.findByRole('button', { name: /slack/i }));

    // An entry is a convenience; the vendor's page is the authority. It is one
    // click away at the moment somebody might doubt a value.
    const link = screen.getByRole('link', { name: /slack sso documentation/i });
    expect(link).toHaveAttribute('href', slack.docsUrl);
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('stops on the secret for an OIDC application', async () => {
    const user = userEvent.setup();
    mockApi(() =>
      json({ applicationId: 'a1', slug: 'grafana', clientId: 'grafana-abc', clientSecret: 'sec-xyz' }, 201),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add from the catalog/i }));
    await user.click(await screen.findByRole('button', { name: /grafana/i }));
    await user.type(screen.getByLabelText(/grafana hostname/i), 'grafana.acme.test');
    await user.click(screen.getByRole('button', { name: /^add grafana$/i }));

    // The secret exists in that response and nowhere else. Closing the flow
    // before it has been copied would throw it away.
    expect(await screen.findByDisplayValue('sec-xyz')).toBeInTheDocument();
    expect(screen.getByDisplayValue('grafana-abc')).toBeInTheDocument();
  });

  it('shows the server’s refusal and keeps what was typed', async () => {
    const user = userEvent.setup();
    mockApi(() =>
      json(
        {
          title: 'Already registered',
          detail: '"Slack" is already registered with the entity ID https://slack.com.',
          status: 409,
        },
        409,
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add from the catalog/i }));
    await user.click(await screen.findByRole('button', { name: /slack/i }));
    await user.type(screen.getByLabelText(/workspace subdomain/i), 'acme-eu');
    await user.click(screen.getByRole('button', { name: /^add slack$/i }));

    expect(await screen.findByText(/already registered with the entity id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/workspace subdomain/i)).toHaveValue('acme-eu');
  });

  it('sends a category when one is given, and omits it when blank', async () => {
    // The column is nullable and an empty string would be a category whose
    // heading is nothing — a group in the portal with a blank title.
    const user = userEvent.setup();
    const sent = mockApi(() => json({ id: 'a1' }, 201));
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add by hand/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'Payroll');
    await user.type(screen.getByLabelText(/^slug$/i), 'payroll');
    await user.type(screen.getByLabelText(/launch url/i), 'https://payroll.acme.test/');
    await user.click(screen.getByRole('button', { name: /save application/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).not.toHaveProperty('category');
  });

  it('sends the category that was typed', async () => {
    const user = userEvent.setup();
    const sent = mockApi(() => json({ id: 'a1' }, 201));
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add by hand/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'Payroll');
    await user.type(screen.getByLabelText(/^slug$/i), 'payroll');
    await user.type(screen.getByLabelText(/launch url/i), 'https://payroll.acme.test/');
    await user.type(screen.getByLabelText(/^category$/i), '  Finance  ');
    await user.click(screen.getByRole('button', { name: /save application/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // Trimmed: a pasted value arrives with whitespace, and the portal groups
    // by exact string.
    expect(sent[0]!.body).toMatchObject({ category: 'Finance' });
  });
});
