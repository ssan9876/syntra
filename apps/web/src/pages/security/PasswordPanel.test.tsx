import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasswordPanel } from './PasswordPanel.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const problem = (
  status: number,
  type: string,
  title: string,
  detail: string,
  errors?: { path: string; message: string }[],
) =>
  json(
    { type: `https://syntra.dev/problems/${type}`, title, status, detail, ...(errors ? { errors } : {}) },
    status,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

/** Fills all three boxes and submits. */
async function change(
  user: ReturnType<typeof userEvent.setup>,
  current = 'old passphrase here',
  next = 'new passphrase here',
  confirm = next,
) {
  await user.type(screen.getByLabelText(/current password/i), current);
  await user.type(screen.getByLabelText(/^new password/i), next);
  await user.type(screen.getByLabelText(/confirm new password/i), confirm);
  await user.click(screen.getByRole('button', { name: /change password/i }));
}

describe('PasswordPanel', () => {
  it('posts the change and confirms how many sessions went', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ok: true, otherSessionsRevoked: 2 }));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    render(<PasswordPanel />);

    await change(user);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe('/api/auth/password');
    expect(JSON.parse(init.body)).toEqual({
      currentPassword: 'old passphrase here',
      newPassword: 'new passphrase here',
    });
    expect(await screen.findByText(/2 other sessions were signed out/i)).toBeInTheDocument();
  });

  it('says it in the singular for one session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true, otherSessionsRevoked: 1 })));
    render(<PasswordPanel />);
    await change(userEvent.setup());
    expect(await screen.findByText(/1 other session was signed out/i)).toBeInTheDocument();
  });

  it('does not mention sessions when none were signed out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true, otherSessionsRevoked: 0 })));
    render(<PasswordPanel />);
    await change(userEvent.setup());
    expect(await screen.findByText('Password changed.')).toBeInTheDocument();
  });

  /**
   * A typing mistake, knowable here, and not worth a round trip — so it must
   * not become one.
   */
  it('will not submit when the two new entries differ', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    render(<PasswordPanel />);

    await change(user, 'old passphrase here', 'new passphrase here', 'typed it wrong');

    expect(await screen.findByText(/does not match the new password/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * `detail` is the sentence written for this exact refusal. Falling back to
   * `title` would replace it with the category — "Password rejected" — which
   * tells somebody nothing about what to do differently.
   */
  it('shows the server’s reason rather than the category', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      problem(422, 'weak-password', 'Password rejected',
        'Choose something less predictable than your own name or login.',
        [{ path: 'newPassword', message: 'too_obvious' }]),
    ));
    render(<PasswordPanel />);
    await change(userEvent.setup());

    expect(
      await screen.findByText(/less predictable than your own name or login/i),
    ).toBeInTheDocument();
  });

  it('sends an upstream account to its provider', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      problem(409, 'password-held-upstream', 'Password is managed elsewhere',
        'This account signs in through Contoso ID. Change the password there.'),
    ));
    render(<PasswordPanel />);
    await change(userEvent.setup());

    expect(await screen.findByText(/signs in through Contoso ID/i)).toBeInTheDocument();
  });

  /**
   * Being made to retype a long passphrase because the OTHER box was wrong is
   * the kind of small cruelty that teaches people to pick shorter ones.
   */
  it('keeps what was typed when the attempt is refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      problem(403, 'wrong-password', 'Current password is incorrect',
        'The current password does not match.',
        [{ path: 'currentPassword', message: 'Incorrect' }]),
    ));
    render(<PasswordPanel />);
    await change(userEvent.setup());

    await screen.findByText(/does not match/i);
    expect(screen.getByLabelText(/^new password/i)).toHaveValue('new passphrase here');
    expect(screen.getByLabelText(/confirm new password/i)).toHaveValue('new passphrase here');
  });

  it('clears every box after a successful change', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true, otherSessionsRevoked: 0 })));
    render(<PasswordPanel />);
    await change(userEvent.setup());

    await screen.findByText('Password changed.');
    for (const label of [/current password/i, /^new password/i, /confirm new password/i]) {
      expect(screen.getByLabelText(label)).toHaveValue('');
    }
  });
});
