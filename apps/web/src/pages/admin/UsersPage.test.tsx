import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UsersPage } from './UsersPage.js';

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
  sources: { id: string; name: string }[] = [{ id: 's1', name: 'Corporate LDAP' }],
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
      <UsersPage />
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
