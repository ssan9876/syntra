import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RenewPassword } from './RenewPassword.js';
import { storeChallenge } from '../mfa/challenge-store.js';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const refresh = vi.fn();
vi.mock('../session/SessionProvider.js', () => ({
  useSession: () => ({ refresh }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  }) as never;

const renderPage = () =>
  render(
    <MemoryRouter>
      <RenewPassword />
    </MemoryRouter>,
  );

/** A live renewal challenge, as `Login` would have stored it. */
function pending(returnTo = '/') {
  storeChallenge({
    kind: 'renew',
    attemptToken: 'attempt-123',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    factors: [],
    returnTo,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  navigate.mockReset();
  refresh.mockReset();
  sessionStorage.clear();
});

describe('RenewPassword', () => {
  it('says the sign-in expired when there is no challenge to spend', async () => {
    renderPage();

    expect(
      await screen.findByText(/that sign-in has expired/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^new password$/i)).toBeNull();
  });

  it('posts the new password with the attempt token', async () => {
    const user = userEvent.setup();
    pending();
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return json({ status: 'authenticated' });
    });
    renderPage();

    await user.type(await screen.findByLabelText(/^new password$/i), 'a good long one 1');
    await user.type(screen.getByLabelText(/again/i), 'a good long one 1');
    await user.click(screen.getByRole('button', { name: /save and sign in/i }));

    await waitFor(() =>
      expect(bodies).toEqual([
        { attemptToken: 'attempt-123', newPassword: 'a good long one 1' },
      ]),
    );
  });

  it('will not submit when the two entries differ', async () => {
    const user = userEvent.setup();
    pending();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPage();

    await user.type(await screen.findByLabelText(/^new password$/i), 'a good long one 1');
    await user.type(screen.getByLabelText(/again/i), 'a good long one 2');
    await user.click(screen.getByRole('button', { name: /save and sign in/i }));

    // Caught here rather than at the server: a mistyped confirmation must not
    // spend the attempt.
    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the server’s reason and keeps the form usable', async () => {
    const user = userEvent.setup();
    pending();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        { title: 'Password rejected', detail: 'That is one of your last 5 passwords.', status: 422 },
        422,
      ),
    );
    renderPage();

    await user.type(await screen.findByLabelText(/^new password$/i), 'an old one 111');
    await user.type(screen.getByLabelText(/again/i), 'an old one 111');
    await user.click(screen.getByRole('button', { name: /save and sign in/i }));

    expect(
      await screen.findByText(/one of your last 5 passwords/i),
    ).toBeInTheDocument();
    // Still on the form: a refused password is retried, not restarted.
    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
  });

  it('sends the user back to start when the attempt has been spent', async () => {
    const user = userEvent.setup();
    pending();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ title: 'That sign-in has expired', status: 401 }, 401),
    );
    renderPage();

    await user.type(await screen.findByLabelText(/^new password$/i), 'a good long one 1');
    await user.type(screen.getByLabelText(/again/i), 'a good long one 1');
    await user.click(screen.getByRole('button', { name: /save and sign in/i }));

    // A 401 cannot be retried from here, so the screen stops offering the form.
    expect(await screen.findByText(/that sign-in has expired/i)).toBeInTheDocument();
  });

  it('returns to where the sign-in was headed', async () => {
    const user = userEvent.setup();
    pending('/catalog');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'authenticated' }));
    renderPage();

    await user.type(await screen.findByLabelText(/^new password$/i), 'a good long one 1');
    await user.type(screen.getByLabelText(/again/i), 'a good long one 1');
    await user.click(screen.getByRole('button', { name: /save and sign in/i }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/catalog', { replace: true }),
    );
    expect(refresh).toHaveBeenCalled();
  });
});

/**
 * The password rules, as live constraints rather than permanent captions.
 *
 * Both boxes used to carry a `hint` — a grey sentence shown to everybody,
 * always, including the reader who had already typed a good password. The
 * rule is unchanged; what changed is when it is said. This matters most on
 * exactly this screen: somebody reaches it because they are already locked
 * out, so a round trip to the server to be told the two boxes differ is the
 * worst possible moment to spend one.
 */
describe('the password rules', () => {
  it('says nothing before anything is typed', async () => {
    pending();
    renderPage();
    await screen.findByLabelText(/^new password$/i);
    expect(screen.queryByText(/at least twelve characters/i)).not.toBeInTheDocument();
  });

  it('states the length rule only while it is being broken', async () => {
    pending();
    renderPage();
    const box = await screen.findByLabelText(/^new password$/i);

    await userEvent.type(box, 'short');
    expect(await screen.findByText(/at least twelve characters/i)).toBeInTheDocument();

    await userEvent.type(box, 'enough-to-pass-now');
    await waitFor(() =>
      expect(screen.queryByText(/at least twelve characters/i)).not.toBeInTheDocument(),
    );
  });

  it('catches a mismatch without a round trip to the server', async () => {
    pending();
    renderPage();
    await userEvent.type(await screen.findByLabelText(/^new password$/i), 'a-long-enough-one');
    await userEvent.type(screen.getByLabelText(/new password again/i), 'a-different-one');

    expect(await screen.findByText(/are not the same/i)).toBeInTheDocument();
  });
});
