import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ResetPassword } from './ResetPassword.js';

const renderAt = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/reset-password${search}`]}>
      <ResetPassword />
    </MemoryRouter>,
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('ResetPassword', () => {
  it('says the link is unusable when there is no token', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('');
    expect(await screen.findByText(/no longer usable/i)).toBeInTheDocument();
  });

  it('says the link is unusable when preflight rejects it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ valid: false, requiresFactor: false, acceptableFactors: [] })),
    );
    renderAt('?token=stale');
    expect(await screen.findByText(/no longer usable/i)).toBeInTheDocument();
  });

  it('asks only for a password when no factor is registered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ valid: true, requiresFactor: false, acceptableFactors: [] })),
    );
    renderAt('?token=good');
    expect(await screen.findByLabelText(/new password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/recovery code/i)).not.toBeInTheDocument();
  });

  it('asks for the second factor when one is registered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ valid: true, requiresFactor: true, acceptableFactors: ['totp', 'recovery_code'] }),
      ),
    );
    renderAt('?token=good');
    expect(await screen.findByLabelText(/code from your app/i)).toBeInTheDocument();
  });

  it('sends the password and the factor together', async () => {
    const fetchSpy = vi.fn(async (url: unknown, _init?: RequestInit) =>
      String(url).includes('preflight')
        ? json({ valid: true, requiresFactor: true, acceptableFactors: ['totp'] })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    renderAt('?token=good');
    await userEvent.type(await screen.findByLabelText(/new password/i), 'a long enough passphrase');
    await userEvent.type(screen.getByLabelText(/code from your app/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /set the password/i }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).includes('/complete'));
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        token: 'good',
        newPassword: 'a long enough passphrase',
        factor: { type: 'totp', code: '123456' },
      });
    });
  });

  it('shows the server message when the password is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('preflight')
          ? json({ valid: true, requiresFactor: false, acceptableFactors: [] })
          : json(
              { status: 400, title: 'Weak password', detail: 'Choose a longer password.' },
              400,
            ),
      ),
    );

    renderAt('?token=good');
    await userEvent.type(await screen.findByLabelText(/new password/i), 'short');
    await userEvent.click(screen.getByRole('button', { name: /set the password/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/longer password/i);
  });
});
