import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session/SessionProvider.js';
import { Login } from './Login.js';

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

const SESSION = {
  // The login response now says which of the three outcomes it is; only this
  // one carries a session.
  status: 'authenticated',
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'J Doe',
  scope: 'portal',
  mayElevate: false,
  permissions: [],
};

const renderLogin = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <Login />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Login', () => {
  it('submits the credentials to the API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(problem('unauthenticated', 401));
    fetchMock.mockResolvedValueOnce(json(SESSION));

    renderLogin();
    await userEvent.type(await screen.findByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      );
    });
  });

  it('shows one generic message for a rejected login', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(problem('unauthenticated', 401));
    fetchMock.mockResolvedValueOnce(problem('invalid-credentials', 401));

    renderLogin();
    await userEvent.type(await screen.findByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // The API deliberately cannot distinguish wrong password from unknown
    // user; the interface must not invent a distinction either.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /login and password do not match an account/i,
    );
  });

  it('reports a rate limit differently from a bad password', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(problem('unauthenticated', 401));
    fetchMock.mockResolvedValueOnce(problem('bad-request', 429));

    renderLogin();
    await userEvent.type(await screen.findByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many/i);
  });

  it('disables the button while the request is in flight', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(problem('unauthenticated', 401));
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }) as never,
    );

    renderLogin();
    await userEvent.type(await screen.findByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret');
    const button = screen.getByRole('button', { name: /sign in/i });
    await userEvent.click(button);

    expect(button).toBeDisabled();
    release(problem('invalid-credentials', 401));
  });

  it('marks the fields invalid when the login is rejected', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(problem('unauthenticated', 401));
    fetchMock.mockResolvedValueOnce(problem('invalid-credentials', 401));

    renderLogin();
    await userEvent.type(await screen.findByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByRole('alert');
    expect(screen.getByLabelText(/password/i)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});
