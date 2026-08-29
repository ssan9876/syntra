import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session/SessionProvider.js';
import { Security } from './Security.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const status = (over: Record<string, unknown> = {}) => ({
  totp: { enrolled: true },
  webauthn: { available: true, unavailableReason: null, credentials: [] },
  recoveryCodes: { remaining: 5 },
  ...over,
});

/**
 * Records what was sent, and answers the two endpoints this screen reads.
 * The same shape `StatusToggle.test.tsx` uses: branch on the URL, return a
 * real `Response`, keep the calls for assertions.
 */
function mockApi(over: { totpDelete?: Response } = {}) {
  const calls: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (init?.method === 'DELETE' && url.endsWith('/api/auth/mfa/totp')) {
      return Promise.resolve(over.totpDelete ?? json({ recoveryCodesRevoked: 0 }));
    }
    if (url.endsWith('/api/auth/mfa')) return Promise.resolve(json(status()));
    if (url.endsWith('/api/portal/sessions')) {
      return Promise.resolve(json({ sessions: [] }));
    }
    if (url.endsWith('/api/auth/session')) return Promise.resolve(json({}, 401));
    return Promise.resolve(json({}));
  });
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <Security />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the authenticator app can be removed without an administrator', () => {
  it('sends the DELETE and reloads', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('Set up');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/auth/mfa/totp')),
      ).toBe(true),
    );
  });

  /**
   * The count is the one thing the user cannot find out any other way: the
   * codes they printed have just stopped working, and a screen that said
   * nothing would send them to a drawer full of dead codes in six months.
   */
  it('says how many recovery codes stopped working with it', async () => {
    mockApi({ totpDelete: json({ recoveryCodesRevoked: 7 }) });
    renderPage();
    await screen.findByText('Set up');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText(/7 unused recovery codes stopped working/),
    ).toBeInTheDocument();
  });

  it('reports a refusal instead of appearing to do nothing', async () => {
    mockApi({
      totpDelete: json(
        {
          type: 'https://syntra.dev/problems/no-totp',
          title: 'No authenticator app is set up',
          status: 409,
          detail: 'There is nothing to remove.',
        },
        409,
      ),
    });
    renderPage();
    await screen.findByText('Set up');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('There is nothing to remove.')).toBeInTheDocument();
  });
});

describe('removing a security key says what it cost', () => {
  const withKey = () => ({
    ...status(),
    webauthn: {
      available: true,
      unavailableReason: null,
      credentials: [
        { id: 'k1', label: 'YubiKey', createdAt: '2026-01-02T00:00:00.000Z', lastUsedAt: null },
      ],
    },
  });

  function mockWithKey(deleteResponse: Response) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE' && url.includes('/webauthn/')) {
        return Promise.resolve(deleteResponse);
      }
      if (url.endsWith('/api/auth/mfa')) return Promise.resolve(json(withKey()));
      if (url.endsWith('/api/portal/sessions')) {
      return Promise.resolve(json({ sessions: [] }));
    }
    if (url.endsWith('/api/auth/session')) return Promise.resolve(json({}, 401));
      return Promise.resolve(json({}));
    });
  }

  it('tells the user the printed codes have stopped working', async () => {
    mockWithKey(json({ recoveryCodesRevoked: 4 }));
    renderPage();
    await screen.findByText('YubiKey');

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    expect(
      await screen.findByText(/4 unused recovery codes stopped working with it/),
    ).toBeInTheDocument();
  });

  /**
   * There was no catch here at all, so a refusal was an unhandled rejection
   * and the button read as broken.
   */
  it('reports a refusal instead of doing nothing visible', async () => {
    mockWithKey(
      json(
        {
          type: 'https://syntra.dev/problems/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'That key is not yours.',
        },
        403,
      ),
    );
    renderPage();
    await screen.findByText('YubiKey');

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    expect(await screen.findByText('That key is not yours.')).toBeInTheDocument();
  });
});
