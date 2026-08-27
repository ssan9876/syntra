import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AccountsTab } from './AccountsTab.js';

const users = [
  {
    id: 'u1',
    login: 'jdoe',
    displayName: 'J Doe',
    email: 'j@acme.test',
    status: 'active',
    statusReason: null,
    sourceId: null,
  },
  {
    id: 'u2',
    login: 'sroe',
    displayName: 'S Roe',
    email: 's@acme.test',
    status: 'inactive',
    statusReason: 'left the company',
    sourceId: null,
  },
];

const synced = {
  id: 'u3',
  login: 'nhaddad',
  displayName: 'N Haddad',
  email: 'n@acme.test',
  status: 'active',
  statusReason: null,
  sourceId: 's1',
};

/** The users list and the source list are separate reads, as on the run pages. */
function mockBoth(
  rows: Record<string, unknown>[],
  sources: Record<string, unknown>[] = [
    {
      id: 's1',
      name: 'Corporate LDAP',
      writebackEnabled: false,
      writebackPassword: false,
      writebackDisable: false,
    },
  ],
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      String(input).includes('/sources')
        ? json({ sources })
        : json({ users: rows }),
    ),
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const renderPage = () =>
  render(
    <MemoryRouter>
      <AccountsTab />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('UsersPage', () => {
  it('lists users returned by the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ users }));
    renderPage();

    expect(await screen.findByText('J Doe')).toBeInTheDocument();
    expect(screen.getByText('S Roe')).toBeInTheDocument();
  });

  it('marks an inactive user visibly rather than hiding it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ users }));
    renderPage();

    const row = (await screen.findByText('S Roe')).closest('tr')!;
    expect(row).toHaveTextContent(/inactive/i);
  });

  it('shows why an account was deactivated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ users }));
    renderPage();

    const row = (await screen.findByText('S Roe')).closest('tr')!;
    expect(row).toHaveTextContent(/left the company/i);
  });

  it('shows an empty state naming the next action', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ users: [] }));
    renderPage();

    expect(await screen.findByText(/no users yet/i)).toBeInTheDocument();
  });

  it('names the directory that owns a synced account, and says it is read-only', async () => {
    mockBoth([...users, synced]);
    renderPage();

    const row = (await screen.findByText('N Haddad')).closest('tr')!;
    expect(row).toHaveTextContent('Corporate LDAP');
    expect(row).toHaveTextContent(/read-only/i);
  });

  it('says a locally managed account is Syntra’s own', async () => {
    mockBoth([...users, synced]);
    renderPage();

    const row = (await screen.findByText('J Doe')).closest('tr')!;
    expect(row).toHaveTextContent('Syntra');
    expect(row).not.toHaveTextContent(/read-only/i);
  });

  it('falls back to naming it a directory source when the source list is unreadable', async () => {
    // sync.read and directory.read are separate permissions. Losing the source
    // name must not cost the reader the fact that the account is managed
    // elsewhere.
    mockBoth([synced], []);
    renderPage();

    const row = (await screen.findByText('N Haddad')).closest('tr')!;
    expect(row).toHaveTextContent('Directory source');
  });

  it('says nothing about directories when every account is local', async () => {
    mockBoth(users);
    renderPage();

    await screen.findByText('J Doe');
    expect(screen.queryByText(/managed elsewhere/i)).toBeNull();
  });

  it('explains once, above the table, where a synced field is changed', async () => {
    mockBoth([...users, synced]);
    renderPage();

    expect(
      await screen.findByText(/some of these accounts are managed elsewhere/i),
    ).toBeInTheDocument();
  });

  it('surfaces a permission failure as a message, not a blank page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          type: 'https://syntra.dev/problems/forbidden',
          title: 'Forbidden',
          status: 403,
        },
        403,
      ),
    );
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /do not have permission/i,
    );
  });

  it('prefers the REASON the server gave over the generic refusal', async () => {
    // The portal refuses an account with no linked person with a 403 that
    // says exactly that. Flattening it to "you do not have permission" sends
    // the reader to an administrator to be given a permission that was never
    // the problem — the account needs a person record, which is a different
    // request entirely.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          type: 'https://syntra.dev/problems/no-person',
          title: 'Not available to you',
          status: 403,
          detail:
            'This account is not linked to a person record, so it cannot ask for anything or hold anything.',
        },
        403,
      ),
    );
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not linked to a person record/i);
    expect(alert).not.toHaveTextContent(/do not have permission/i);
  });
});

/**
 * The button that could not exist before. A source-owned account used to be
 * refused outright, because the next sync run would read it as present in the
 * directory and propose reactivating it -- so the control would have appeared
 * to work and quietly undone itself.
 */
describe('UsersPage — deactivating a directory-managed account', () => {
  const writingSource = [
    {
      id: 's1',
      name: 'Corporate LDAP',
      writebackEnabled: true,
      writebackPassword: false,
      writebackDisable: true,
    },
  ];

  it('offers Deactivate when the source allows write-back', async () => {
    mockBoth([synced], writingSource);
    renderPage();

    expect(await screen.findByText('nhaddad')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deactivate/i })).toBeInTheDocument();
  });

  /**
   * ...and does not when it does not. Naming the source and the setting is the
   * difference between a dead end and something an administrator can act on --
   * the old copy said only "managed by a directory source", which is a fact
   * with nowhere to go.
   */
  it('says which source owns the account and that write-back is off', async () => {
    mockBoth([synced]);
    renderPage();

    expect(
      await screen.findByText(/Corporate LDAP owns this account, and write-back is off/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
  });

  it('needs BOTH the master switch and the disable permission', async () => {
    mockBoth([synced], [
      {
        id: 's1',
        name: 'Corporate LDAP',
        writebackEnabled: false,
        writebackPassword: false,
        writebackDisable: true,
      },
    ]);
    renderPage();

    await screen.findByText('nhaddad');
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
  });

  /**
   * The confirmation says what actually happens, in order. One that asks "are
   * you sure?" without saying what follows is one people click through.
   */
  it('spells out the consequences before the deactivation is taken', async () => {
    mockBoth([synced], writingSource);
    renderPage();

    await screen.findByText('nhaddad');
    await userEvent.click(screen.getByRole('button', { name: /deactivate/i }));

    expect(
      await screen.findByText(/disabled in Corporate LDAP immediately/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/leaver steps configured on the target/i)).toBeInTheDocument();
  });
});

/**
 * The link an administrator hands to somebody who has no password yet.
 *
 * Rendered to copy rather than to click: an administrator who follows the link
 * to check it has spent the token, and the joiner gets a dead page.
 */
describe('password setup link', () => {
  it('shows a link to copy, and says it supersedes the last one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/password-setup')) {
        return Promise.resolve(
          json({
            url: 'https://acme.test/reset-password?token=abc123',
            expiresAt: '2026-08-25T12:00:00.000Z',
          }),
        );
      }
      if (url.includes('/sources')) return Promise.resolve(json({ sources: [] }));
      return Promise.resolve(json({ users }));
    });
    renderPage();

    const row = (await screen.findByText('J Doe')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Password link' }));

    expect(
      await screen.findByDisplayValue('https://acme.test/reset-password?token=abc123'),
    ).toBeInTheDocument();
    expect(screen.getByText(/stops the previous link working/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /reset-password/ })).toBeNull();
  });

  it('offers nothing for a user whose password lives upstream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ users: [{ ...users[0], passwordSource: 'upstream' }] }),
    );
    renderPage();

    await screen.findByText('J Doe');
    expect(screen.queryByRole('button', { name: 'Password link' })).toBeNull();
  });
});

describe('taking a factor off a user', () => {
  /**
   * The way back in for somebody who lost their phone, and the way an
   * administrator revokes a factor an attacker enrolled. The route existed and
   * wrote its own audit event naming the administrator; no screen reached it,
   * so the answer to "I lost my authenticator" was a database client.
   */
  const mockFactors = (rows: Record<string, unknown>[], response: Response) => {
    const sent: { url: string; method: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE') {
        sent.push({ url, method: 'DELETE' });
        return Promise.resolve(response);
      }
      if (url.includes('/sources')) return Promise.resolve(json({ sources: [] }));
      return Promise.resolve(json({ users: rows }));
    });
    return sent;
  };

  it('removes the authenticator app and says what it cost', async () => {
    const sent = mockFactors([users[0]!], json({ recoveryCodesRevoked: 3 }));
    renderPage();
    await screen.findByText('jdoe');

    await userEvent.click(screen.getByRole('button', { name: 'Factors' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove authenticator app' }),
    );

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain('/api/admin/users/u1/factors/totp');
    expect(sent[0]!.method).toBe('DELETE');
    expect(
      await screen.findByText(/3 unused recovery codes stopped working/),
    ).toBeInTheDocument();
  });

  it('removes security keys too', async () => {
    const sent = mockFactors([users[0]!], json({ recoveryCodesRevoked: 0 }));
    renderPage();
    await screen.findByText('jdoe');

    await userEvent.click(screen.getByRole('button', { name: 'Factors' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove security keys' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain('/factors/webauthn');
  });
});

describe('UsersPage and account lockout', () => {
  const lockedOut = { ...users[0]!, locked: true };

  it('labels a locked-out account without calling it inactive', async () => {
    // Locked and inactive are different sentences with different ways out.
    // Collapsing them would send an administrator to Reactivate, which is not
    // the control that helps.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ users: [lockedOut] }));
    renderPage();

    const row = (await screen.findByText('J Doe')).closest('tr')!;
    expect(row).toHaveTextContent(/locked out/i);
    expect(row).toHaveTextContent(/active/i);
    expect(row).not.toHaveTextContent(/inactive/i);
  });

  it('offers Unlock only on a locked row', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ users: [lockedOut, users[1]!] }),
    );
    renderPage();

    const locked = (await screen.findByText('J Doe')).closest('tr')!;
    const other = screen.getByText('S Roe').closest('tr')!;
    expect(within(locked).getByRole('button', { name: /unlock/i })).toBeInTheDocument();
    expect(within(other).queryByRole('button', { name: /unlock/i })).toBeNull();
  });

  it('posts the unlock and reloads the list', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    let locked = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.includes('/unlock')) {
        locked = false;
        return Promise.resolve(json({}));
      }
      if (url.includes('/sources')) return Promise.resolve(json({ sources: [] }));
      return Promise.resolve(json({ users: [{ ...users[0]!, locked }] }));
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock/i }));

    expect(calls).toContain('POST /api/admin/users/u1/unlock');
    // The row stops offering it, which is how the administrator knows it took.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /unlock/i })).toBeNull(),
    );
  });

  it('says so when the unlock is refused', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/unlock')) {
        return Promise.resolve(
          json({ title: 'Forbidden', detail: 'You cannot unlock accounts.' }, 403),
        );
      }
      if (url.includes('/sources')) return Promise.resolve(json({ sources: [] }));
      return Promise.resolve(json({ users: [lockedOut] }));
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock/i }));

    expect(
      await screen.findByText(/you cannot unlock accounts/i),
    ).toBeInTheDocument();
  });
});
