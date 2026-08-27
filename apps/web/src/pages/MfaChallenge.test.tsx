import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session/SessionProvider.js';
import { storeChallenge } from '../mfa/challenge-store.js';
import { MfaChallenge } from './MfaChallenge.js';

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <MfaChallenge />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = (impl: (url: string, init?: RequestInit) => Response) => {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) =>
    impl(String(url), init),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
};

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const problem = (status: number) =>
  new Response(JSON.stringify({ status, title: 'Invalid credentials' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

describe('MfaChallenge', () => {
  it('sends the user back to sign in when there is no pending challenge', async () => {
    stubFetch(() => problem(401));
    renderPage();
    expect(
      await screen.findByText(/sign in again/i),
    ).toBeInTheDocument();
  });

  it('asks for a code and accepts it', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    const fetchSpy = stubFetch((url) =>
      url.includes('/api/auth/mfa/verify')
        ? ok({ status: 'authenticated', userId: 'u', displayName: 'J', scope: 'portal', mayElevate: false, permissions: [] })
        : problem(401),
    );

    renderPage();
    await userEvent.type(await screen.findByLabelText(/code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) =>
        String(u).includes('/api/auth/mfa/verify'),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toEqual({
        type: 'totp',
        attemptToken: 'token-1',
        code: '123456',
      });
    });
  });

  it('states a rejected code in plain language and lets the user try again', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    stubFetch(() => problem(401));

    renderPage();
    await userEvent.type(await screen.findByLabelText(/code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not match/i);
    expect(screen.getByRole('button', { name: /verify/i })).toBeEnabled();
  });

  /**
   * The server decides whether a printed code is acceptable and says so in
   * `acceptableFactors`: it satisfies "any second factor" and never a rule
   * naming a security key. The screen offers what the server named, and these
   * two cases are the guard, not the gap — the version that offered the button
   * unconditionally passed a test asserting it appeared against
   * `factors: ['totp']`, which certified the defect.
   */
  it('offers a recovery code when the server says one would be taken', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp', 'recovery_code'],
      returnTo: '/',
    });
    stubFetch(() => problem(401));

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /recovery code/i }));
    expect(screen.getByLabelText(/recovery code/i)).toBeInTheDocument();
  });

  it('does not offer one the server would refuse', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      // A rule naming a security key. A recovery code is not that key, the
      // server refuses it in both directions, and offering it here would leave
      // the user pressing a button that can only ever fail.
      factors: ['webauthn'],
      returnTo: '/',
    });
    stubFetch(() => problem(401));

    renderPage();
    expect(await screen.findByRole('button', { name: /verify/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /recovery code/i }),
    ).not.toBeInTheDocument();
  });

  it('does not advise a recovery code in the retry message when there is none', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    stubFetch(() => problem(401));

    renderPage();
    await userEvent.type(await screen.findByLabelText(/code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));

    // Advice the user cannot act on is how a retry becomes a loop.
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/recovery/i);
  });

  /**
   * The server answers a verified factor with a fresh `challenge` or `enrol`
   * when a rule tightened underneath the user. Both arms carry no cookie, so
   * walking on as though a session had been issued lands them on a page that
   * bounces to /login with nothing said.
   */
  it('takes a further challenge handed back instead of assuming a session', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    stubFetch((url) =>
      url.includes('/api/auth/mfa/verify')
        ? ok({
            status: 'challenge',
            attemptToken: 'token-2',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            acceptableFactors: ['webauthn'],
          })
        : problem(401),
    );

    renderPage();
    await userEvent.type(await screen.findByLabelText(/code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/different factor/i);
    expect(screen.getByText(/security key or passkey/i)).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem('syntra.challenge')!)).toMatchObject({
      kind: 'verify',
      attemptToken: 'token-2',
      factors: ['webauthn'],
    });
  });

  it('sends an enrolment handed back to the enrolment screen', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/portal',
    });
    stubFetch((url) =>
      url.includes('/api/auth/mfa/verify')
        ? ok({
            status: 'enrol',
            attemptToken: 'token-3',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            enrollableFactors: ['webauthn'],
          })
        : problem(401),
    );

    renderPage();
    await userEvent.type(await screen.findByLabelText(/code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem('syntra.challenge')!)).toMatchObject({
        kind: 'enrol',
        attemptToken: 'token-3',
        factors: ['webauthn'],
        returnTo: '/portal',
      });
    });
  });

  it('offers an emailed code only when the server named it', () => {
    // `offers`, like every other factor button here: the server decides what
    // is acceptable, and offering one it will refuse walks somebody into a
    // loop with no way out.
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    stubFetch(() => ok({ status: 'authenticated' }));
    renderPage();

    expect(screen.queryByRole('button', { name: /email me a code/i })).toBeNull();
  });

  it('asks for a code to be sent, and claims nothing more', async () => {
    const user = userEvent.setup();
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['email_otp'],
      returnTo: '/',
    });
    const spy = stubFetch(() => ok({ ok: true }));
    renderPage();

    // The only factor offered, so the screen already opens on it — there is
    // no button to switch to the mode you are already in.
    await user.click(await screen.findByRole('button', { name: /send me a code/i }));

    await waitFor(() =>
      expect(
        spy.mock.calls.some(([url]) => String(url).includes('/mfa/email-otp/send')),
      ).toBe(true),
    );
    // The endpoint answers the same for sent, too-soon, no address and
    // switched-off, so the screen must not claim a code went out.
    expect(screen.getByText(/if a code can be sent/i)).toBeInTheDocument();
  });
});
