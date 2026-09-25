import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session/SessionProvider.js';
import { BrandProvider } from '../branding/BrandProvider.js';
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

describe('Login help', () => {
  const renderBranded = (brand: Record<string, unknown>) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        String(input) === '/api/branding'
          ? json(brand)
          : problem('unauthenticated', 401),
      ),
    );
    return render(
      <MemoryRouter>
        <BrandProvider>
          <SessionProvider>
            <Login />
          </SessionProvider>
        </BrandProvider>
      </MemoryRouter>,
    );
  };

  it("links to the tenant's help desk when one is set", async () => {
    // Somebody who cannot sign in is exactly who needs somewhere to go, and
    // "contact your IT administrator" assumes they know who that is.
    renderBranded({ supportUrl: 'https://help.acme.test/', supportLabel: 'IT service desk' });
    const link = await screen.findByRole('link', { name: 'IT service desk' });
    expect(link).toHaveAttribute('href', 'https://help.acme.test/');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText(/contact your IT administrator/i)).toBeNull();
  });

  it('calls a mailto link "Get help" when the tenant gave it no words', async () => {
    renderBranded({ supportUrl: 'mailto:it@acme.test', supportLabel: null });
    const link = await screen.findByRole('link', { name: 'Get help' });
    expect(link).toHaveAttribute('href', 'mailto:it@acme.test');
    expect(link).not.toHaveAttribute('target');
  });

  it('never renders a javascript: link, even one that reached storage', async () => {
    // The API refuses it on the way in; a row can predate the check.
    renderBranded({ name: 'Acme', supportUrl: 'javascript:alert(1)', supportLabel: 'Help' });
    // The title is set from the same response, so once it reads "Acme" the
    // brand has landed and the absence below is a refusal, not a race.
    await waitFor(() => expect(document.title).toBe('Acme'));
    expect(screen.queryByRole('link', { name: 'Help' })).toBeNull();
    expect(screen.getByText(/contact your IT administrator/i)).toBeInTheDocument();
  });
});
