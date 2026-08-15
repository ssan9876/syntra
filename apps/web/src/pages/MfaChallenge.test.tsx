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

  it('offers a recovery code as an alternative', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    stubFetch(() => problem(401));

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /recovery code/i }));
    expect(screen.getByLabelText(/recovery code/i)).toBeInTheDocument();
  });
});
