import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TenantSettingsPage } from './TenantSettingsPage.js';

const settings = {
  name: 'Acme Care',
  slug: 'acme',
  primaryDomain: 'acme.localhost',
  adminMfaRequired: false,
  selfEnrolmentEnabled: true,
  passwordMinLength: 12,
  webauthnAvailable: true,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const renderPage = () =>
  render(
    <MemoryRouter>
      <TenantSettingsPage />
    </MemoryRouter>,
  );

let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  calls = [];
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stub = (
  handler: (url: string, init?: RequestInit) => Response = () => json(settings),
) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return handler(String(url), init);
    }),
  );
};

describe('TenantSettingsPage', () => {
  it('shows the settings the chokepoint actually reads', async () => {
    stub();
    renderPage();

    expect(
      await screen.findByRole('checkbox', { name: /second factor for the console/i }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /enrol a factor themselves/i }),
    ).toBeChecked();
    expect(screen.getByLabelText(/minimum password length/i)).toHaveValue(12);
  });

  it('saves the change the README told the operator to make', async () => {
    stub();
    renderPage();

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /second factor for the console/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(put).toBeDefined();
      expect(JSON.parse(String(put!.init!.body))).toMatchObject({
        adminMfaRequired: true,
        selfEnrolmentEnabled: true,
      });
    });
  });

  it('warns before the pair that refuses every administrator without a factor', async () => {
    stub();
    renderPage();

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /second factor for the console/i }),
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: /enrol a factor themselves/i }),
    );

    expect(
      await screen.findByText(/nobody can enrol their way in/i),
    ).toBeInTheDocument();
  });

  it('shows the server refusal rather than paraphrasing it', async () => {
    stub((url, init) =>
      init?.method === 'PUT'
        ? json(
            {
              type: 'https://syntra.dev/problems/would-lock-you-out',
              title: 'Set up your own second factor first',
              status: 409,
              detail: 'Enrol from the Security page, then save this again.',
            },
            409,
          )
        : json(settings),
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /second factor for the console/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    expect(await screen.findByText(/enrol from the security page/i)).toBeInTheDocument();
  });

  it('says a security key cannot be registered when the tenant has no domain', async () => {
    stub(() => json({ ...settings, primaryDomain: null, webauthnAvailable: false }));
    renderPage();

    expect(
      await screen.findByText(/only an authenticator app can satisfy it/i),
    ).toBeInTheDocument();
  });
});
