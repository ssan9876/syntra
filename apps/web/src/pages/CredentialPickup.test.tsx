import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CredentialPickup } from './CredentialPickup.js';

const renderAt = (token: string) =>
  render(
    <MemoryRouter initialEntries={[`/credential/${token}`]}>
      <Routes>
        <Route path="/credential/:token" element={<CredentialPickup />} />
      </Routes>
    </MemoryRouter>,
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const status = (state: string) => ({
  state,
  systemName: 'Acme AD',
  username: 'anna.novak',
  expiresAt: '2026-09-28T12:00:00.000Z',
});

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('CredentialPickup', () => {
  it('shows the system and username, and no password until the button is pressed', async () => {
    const fetch = vi.fn(async () => json(status('ready')));
    vi.stubGlobal('fetch', fetch);
    renderAt('tok');

    expect(await screen.findByText('anna.novak')).toBeInTheDocument();
    expect(screen.getByText('Acme AD')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show password/i })).toBeInTheDocument();
    expect(screen.queryByTestId('revealed-password')).not.toBeInTheDocument();
    // Loading the page is ONE read, and never the reveal: a mail scanner that
    // opens the link must not spend it.
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe('/api/credential-pickup/tok');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('reveals the password on the button, with a copy button and a note that the link is spent', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/reveal')
        ? json({ username: 'anna.novak', password: 'Sw0rdfish!Sw0rdfish' })
        : json(status('ready')),
    );
    vi.stubGlobal('fetch', fetch);
    renderAt('tok');

    await userEvent.click(await screen.findByRole('button', { name: /show password/i }));

    expect(await screen.findByTestId('revealed-password')).toHaveTextContent('Sw0rdfish!Sw0rdfish');
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(screen.getByText(/no longer works/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show password/i })).not.toBeInTheDocument();
    const reveal = fetch.mock.calls.find(([url]) => String(url).endsWith('/reveal')) as unknown as [
      string,
      RequestInit,
    ];
    expect(reveal[1].method).toBe('POST');
  });

  it.each([
    ['used', /already been used/i],
    ['expired', /expired/i],
    ['revoked', /withdrawn/i],
  ])('says a %s link is unusable and to contact the administrator', async (state, title) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(status(state))));
    renderAt('tok');

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(/contact your administrator/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show password/i })).not.toBeInTheDocument();
  });

  it('says so when the reveal is refused, as when another tab got there first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/reveal')
          ? json({ type: 'about:blank', title: 'That link no longer works', status: 410 }, 410)
          : json(status('ready')),
      ),
    );
    renderAt('tok');

    await userEvent.click(await screen.findByRole('button', { name: /show password/i }));

    expect(await screen.findByText(/already been used/i)).toBeInTheDocument();
    expect(screen.queryByTestId('revealed-password')).not.toBeInTheDocument();
  });

  it('says an unknown link is not recognised', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ type: 'about:blank', title: 'Not recognised', status: 404 }, 404)),
    );
    renderAt('nope');
    expect(await screen.findByText(/not recognised/i)).toBeInTheDocument();
  });
});
