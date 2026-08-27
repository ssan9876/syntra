import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from '../session/SessionProvider.js';
import { Elevate } from './Elevate.js';
import { takeChallenge } from '../mfa/challenge-store.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const problem = (type: string, status: number) =>
  new Response(
    JSON.stringify({ type: `https://syntra.dev/problems/${type}`, status }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  ) as never;

/** The portal session the user already holds when they reach this screen. */
const PORTAL = {
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'J Doe',
  scope: 'portal',
  mayElevate: true,
  permissions: ['directory.read'],
};

const ADMIN = { status: 'authenticated', ...PORTAL, scope: 'admin' };

/**
 * Shows what the provider is actually holding.
 *
 * The failure this file exists to catch is not a wrong message — it is a
 * non-session stored as the session. `scope` and `permissions` go undefined,
 * the route guard bounces the user out of the console, and the identity
 * vanishes from the header until the page is reloaded. Reading it back is the
 * only way to see that from a test.
 */
function SessionProbe() {
  const { session } = useSession();
  return (
    <span data-testid="probe">
      {session ? `${session.scope}:${session.permissions.join(',')}` : 'none'}
    </span>
  );
}

const renderElevate = () =>
  render(
    <MemoryRouter initialEntries={['/elevate']}>
      <SessionProvider>
        <SessionProbe />
        <Routes>
          <Route path="/elevate" element={<Elevate />} />
          <Route path="/admin/users" element={<h1>Console</h1>} />
          <Route path="/mfa" element={<h1>Step up</h1>} />
          <Route path="/enrol" element={<h1>Enrol</h1>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );

/** Answers the provider's initial session probe, then the elevate POST. */
const arrange = (elevateResponse: Response) => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  fetchMock.mockResolvedValueOnce(json(PORTAL));
  fetchMock.mockResolvedValueOnce(elevateResponse);
  return fetchMock;
};

const submit = async () => {
  await userEvent.type(await screen.findByLabelText(/password/i), 'secret');
  await userEvent.click(screen.getByRole('button', { name: /continue/i }));
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Elevate', () => {
  it('enters the console when the password is enough on its own', async () => {
    arrange(json(ADMIN));
    renderElevate();
    await screen.findByText('portal:directory.read');
    await submit();

    expect(await screen.findByRole('heading', { name: 'Console' })).toBeVisible();
    expect(screen.getByTestId('probe')).toHaveTextContent(
      'admin:directory.read',
    );
  });

  it('keeps the portal session when elevation answers with a challenge', async () => {
    // A tenant with any require_mfa rule answers this on every elevation:
    // elevation re-authenticates from scratch, so the factor presented at
    // sign-in does not carry over. HTTP 200, no cookie, and not a session.
    arrange(
      json({
        status: 'challenge',
        attemptToken: 'tok',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        acceptableFactors: ['totp'],
      }),
    );
    renderElevate();
    await screen.findByText('portal:directory.read');
    await submit();

    // Hands off to the step-up screen rather than into the console.
    expect(await screen.findByRole('heading', { name: 'Step up' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Console' })).toBeNull();

    // The challenge carries the administrative destination, so satisfying the
    // factor does not also cost them the page the guard bounced them from.
    expect(takeChallenge()).toMatchObject({
      kind: 'verify',
      attemptToken: 'tok',
      factors: ['totp'],
      returnTo: '/admin/users',
    });

    // And the portal session they arrived with is untouched.
    expect(screen.getByTestId('probe')).toHaveTextContent(
      'portal:directory.read',
    );
  });

  it('keeps the portal session when elevation asks for an enrolment', async () => {
    arrange(
      json({
        status: 'enrol',
        attemptToken: 'tok',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        enrollableFactors: ['totp'],
      }),
    );
    renderElevate();
    await screen.findByText('portal:directory.read');
    await submit();

    expect(await screen.findByRole('heading', { name: 'Enrol' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Console' })).toBeNull();
    expect(takeChallenge()).toMatchObject({
      kind: 'enrol',
      factors: ['totp'],
      returnTo: '/admin/users',
    });
    expect(screen.getByTestId('probe')).toHaveTextContent(
      'portal:directory.read',
    );
  });

  it('reports a wrong password without disturbing the session', async () => {
    arrange(problem('invalid-credentials', 401));
    renderElevate();
    await screen.findByText('portal:directory.read');
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /password is incorrect/i,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent(
      'portal:directory.read',
    );
  });

  it('says so when the account holds no administrative role', async () => {
    arrange(problem('not-an-administrator', 403));
    renderElevate();
    await screen.findByText('portal:directory.read');
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no administrative roles/i,
    );
  });

  it('sends the password to the elevate endpoint', async () => {
    const fetchMock = arrange(json(ADMIN));
    renderElevate();
    await screen.findByText('portal:directory.read');
    await submit();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/elevate',
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      );
    });
  });
});

/**
 * The destination the guard bounced them from, in full.
 *
 * `intended` read `from.pathname` and nothing else, so the query string was
 * dropped on the way through elevation. That was invisible for as long as no
 * console URL carried meaningful query state — and then the console's
 * navigation collapsed into tabbed destinations whose selected tab lives in
 * `?tab=`, and every deep link through the guard started landing on the wrong
 * tab of the right page.
 *
 * It is the worst shape of bug for a reader to diagnose: they followed a link
 * to the orphan-accounts screen, were asked for their password, and arrived
 * somewhere that looks like it worked.
 */
describe('where elevation returns to', () => {
  // Reports the router's own location. `window.location` does not move under
  // MemoryRouter, so asserting against it would pass whatever the code did —
  // which is exactly the trap the first version of this test fell into.
  function Where() {
    const location = useLocation();
    return <span data-testid="where">{location.pathname + location.search}</span>;
  }

  const renderFrom = (from: { pathname: string; search?: string; hash?: string }) =>
    render(
      <MemoryRouter initialEntries={[{ pathname: '/elevate', state: { from } }]}>
        <SessionProvider>
          <Where />
          <Routes>
            <Route path="/elevate" element={<Elevate />} />
            <Route path="/admin/users" element={<h1>Users</h1>} />
            <Route path="/admin/govern" element={<h1>Governance</h1>} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );

  it('keeps the tab the link asked for', async () => {
    arrange(json(ADMIN));
    renderFrom({ pathname: '/admin/govern', search: '?tab=orphans' });
    await submit();

    expect(await screen.findByRole('heading', { name: 'Governance' })).toBeVisible();
    // The assertion that matters: the right TAB, not merely the right page.
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/govern?tab=orphans');
  });

  it('still works for a destination with no query at all', async () => {
    arrange(json(ADMIN));
    renderFrom({ pathname: '/admin/users' });
    await submit();
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeVisible();
  });

  it('falls back to the console when the guard recorded nothing', async () => {
    arrange(json(ADMIN));
    render(
      <MemoryRouter initialEntries={['/elevate']}>
        <SessionProvider>
          <Routes>
            <Route path="/elevate" element={<Elevate />} />
            <Route path="/admin/users" element={<h1>Users</h1>} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
    await submit();
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeVisible();
  });
});
