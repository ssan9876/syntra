import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { leaveTo } from '../mfa/leave.js';
import { SessionProvider } from '../session/SessionProvider.js';
import { Login } from './Login.js';
import { MfaChallenge } from './MfaChallenge.js';

/**
 * The half of the slice that lives in the browser.
 *
 * A SAML service provider, an OIDC relying party and an upstream identity
 * provider all send a browser into Syntra with a full-page redirect, and get
 * one back the same way. There is no response body in either direction, so the
 * only channel is the URL — and until this task nothing on the React side read
 * it. `/login?next=...` sent the user to the portal instead of back to the
 * service provider, and `/mfa?attempt=...` rendered "This step expired" one
 * hop after Syntra had issued the redirect itself.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const problem = (status: number) =>
  new Response(JSON.stringify({ status, title: 'no' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  }) as never;

const SESSION = {
  status: 'authenticated',
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'J Doe',
  scope: 'portal',
  mayElevate: false,
  permissions: [],
};

/**
 * Where the page asked the browser to go, without jsdom actually going there.
 *
 * `window.location.assign` is non-configurable in jsdom, so the seam is
 * `leaveTo` rather than the global — one line in its own module, mocked here.
 */
vi.mock('../mfa/leave.js', () => ({ leaveTo: vi.fn() }));

const assigned = () => vi.mocked(leaveTo).mock.calls.map(([url]) => url);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

const atUrl = (url: string) => window.history.replaceState({}, '', url);

describe('signing in on the way to a service provider', () => {
  it('returns the browser to the protocol route that sent it here', async () => {
    atUrl(`/login?next=${encodeURIComponent('/saml/continue?handle=abc')}`);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(problem(401)); // the session probe
    fetchMock.mockResolvedValueOnce(json(SESSION));

    render(
      <MemoryRouter>
        <SessionProvider>
          <Login />
        </SessionProvider>
      </MemoryRouter>,
    );
    await userEvent.type(await screen.findByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // A real navigation, not `navigate()`: this router owns no `/saml` route
    // and would fall through its catch-all to the portal, abandoning the
    // service provider's sign-in with nothing on screen to say so.
    await waitFor(() => expect(assigned()).toEqual(['/saml/continue?handle=abc']));
  });

  it('will not be talked into leaving the origin', async () => {
    atUrl(`/login?next=${encodeURIComponent('https://evil.test/steal')}`);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(problem(401));
    fetchMock.mockResolvedValueOnce(json(SESSION));

    render(
      <MemoryRouter>
        <SessionProvider>
          <Login />
        </SessionProvider>
      </MemoryRouter>,
    );
    await userEvent.type(await screen.findByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(assigned()).toEqual([]);
  });
});

describe('a step-up a protocol route redirected to', () => {
  const future = () => new Date(Date.now() + 300_000).toISOString();

  const renderChallenge = () =>
    render(
      <MemoryRouter>
        <SessionProvider>
          <MfaChallenge />
        </SessionProvider>
      </MemoryRouter>,
    );

  it('renders from the query string when nothing was stored', async () => {
    atUrl(
      `/mfa?attempt=tok&factors=totp&expires=${encodeURIComponent(
        future(),
      )}&next=${encodeURIComponent('/saml/continue?handle=abc')}`,
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(401));

    renderChallenge();
    expect(await screen.findByRole('heading', { name: /one more step/i })).toBeVisible();
    expect(screen.getByLabelText(/six-digit code/i)).toBeVisible();
  });

  it('takes the attempt token out of the address bar immediately', async () => {
    atUrl(
      `/mfa?attempt=tok&factors=totp&expires=${encodeURIComponent(future())}&next=%2F`,
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(401));

    renderChallenge();
    await screen.findByRole('heading', { name: /one more step/i });
    // A bearer credential does not stay in the history entry, the Referer
    // header, or any proxy log between here and the browser.
    expect(window.location.search).toBe('');
  });

  it('carries the browser back to the protocol route once the factor is taken', async () => {
    atUrl(
      `/mfa?attempt=tok&factors=totp&expires=${encodeURIComponent(
        future(),
      )}&next=${encodeURIComponent('/saml/continue?handle=abc')}`,
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes('/api/auth/mfa/verify') ? json(SESSION) : json(SESSION),
    );

    renderChallenge();
    await userEvent.type(await screen.findByLabelText(/six-digit code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => expect(assigned()).toEqual(['/saml/continue?handle=abc']));
  });

  it('only offers the factors the server said it would accept', async () => {
    atUrl(
      `/mfa?attempt=tok&factors=totp&expires=${encodeURIComponent(future())}&next=%2F`,
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem(401));

    renderChallenge();
    await screen.findByRole('heading', { name: /one more step/i });
    // The server refuses a recovery code against a rule naming a security
    // key, and offering one it will refuse walks the user into a loop.
    expect(screen.queryByRole('button', { name: /recovery code/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /security key/i })).toBeNull();
  });
});
