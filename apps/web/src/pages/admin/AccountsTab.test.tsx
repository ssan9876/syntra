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

describe('AccountsTab', () => {
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
 * Locked and inactive are different sentences with different ways out, so the
 * list still labels both. The way OUT of a lock now lives on the account's own
 * screen, along with every other control that used to sit on the row.
 */
describe('AccountsTab and account lockout', () => {
  const lockedOut = { ...users[0]!, locked: true };

  it('labels a locked-out account without calling it inactive', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ users: [lockedOut] }));
    renderPage();

    const row = (await screen.findByText('J Doe')).closest('tr')!;
    expect(row).toHaveTextContent(/locked out/i);
    expect(row).toHaveTextContent(/active/i);
    expect(row).not.toHaveTextContent(/inactive/i);
  });
});

/**
 * What the row is FOR, now that it holds nothing else.
 *
 * These assertions are the negative half of the account screen's tests: an
 * action that exists in both places is an action with two implementations, and
 * the one on the row is the one that could never say what it was about to do,
 * because a table cell has no room to.
 */
describe('AccountsTab is a list and nothing else', () => {
  it('opens the account when its name is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ users }));
    renderPage();

    expect(await screen.findByRole('link', { name: 'J Doe' })).toHaveAttribute(
      'href',
      '/admin/users/u1',
    );
  });

  it('carries no per-row controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ users: [{ ...users[0]!, locked: true }] }),
    );
    renderPage();

    const row = (await screen.findByText('J Doe')).closest('tr')!;
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
  });

  it('still creates an account, which is an action on the list itself', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ users }));
    renderPage();

    expect(
      await screen.findByRole('button', { name: /new user/i }),
    ).toBeInTheDocument();
  });
});

/**
 * Who a new account is for.
 *
 * Every account created here used to orphan itself: the form had no person
 * field at all, and the route it posts to had no `personId`.
 */
describe('AccountsTab person picker', () => {
  const PERSONS = [
    {
      id: 'p1',
      givenName: 'Maya',
      familyName: 'Okafor',
      status: 'active',
      orgUnitId: null,
    },
    {
      id: 'p2',
      givenName: 'Kaycen',
      familyName: 'Tyre',
      status: 'active',
      orgUnitId: 'ou1',
    },
    {
      id: 'p3',
      givenName: 'Gone',
      familyName: 'Away',
      status: 'inactive',
      orgUnitId: null,
    },
  ];

  /** Serves every read this form makes, and records or answers the write. */
  function mockForm(write?: () => Response) {
    const writes: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(((
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET') {
        writes.push({ url, body: JSON.parse(String(init!.body)) });
        return Promise.resolve(write?.() ?? json({ id: 'u9' }, 201));
      }
      if (url.includes('/persons')) return Promise.resolve(json({ persons: PERSONS }));
      if (url.includes('/org-units')) {
        return Promise.resolve(
          json({ orgUnits: [{ id: 'ou1', name: 'Care' }, { id: 'ou2', name: 'Sales' }] }),
        );
      }
      if (url.includes('/sources')) return Promise.resolve(json({ sources: [] }));
      return Promise.resolve(json({ users: [] }));
    }) as typeof fetch);
    return writes;
  }

  const openForm = async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'New user' }));
  };

  it('offers service account as an explicit choice, not a blank default', async () => {
    mockForm();
    await openForm();

    const picker = await screen.findByLabelText('Person');
    expect(
      within(picker).getByRole('option', { name: /service account/i }),
    ).toBeInTheDocument();
    expect(
      within(picker).getByRole('option', { name: /Maya Okafor/ }),
    ).toBeInTheDocument();
  });

  it('does not offer somebody who has left', async () => {
    mockForm();
    await openForm();

    const picker = await screen.findByLabelText('Person');
    expect(
      within(picker).queryByRole('option', { name: /Gone Away/ }),
    ).not.toBeInTheDocument();
  });

  it('sends the person that was chosen', async () => {
    const writes = mockForm();
    await openForm();

    await userEvent.type(screen.getByLabelText('Login'), 'mokafor');
    await userEvent.type(screen.getByLabelText('Email'), 'm@acme.test');
    await userEvent.selectOptions(await screen.findByLabelText('Person'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({ personId: 'p1' });
  });

  it('sends a literal null for a service account', async () => {
    const writes = mockForm();
    await openForm();

    await userEvent.type(screen.getByLabelText('Login'), 'svc');
    await userEvent.type(screen.getByLabelText('Email'), 's@acme.test');
    await userEvent.selectOptions(await screen.findByLabelText('Person'), 'none');
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    // Null is what says "service account" to the API and suppresses matching.
    expect((writes[0]!.body as Record<string, unknown>).personId).toBeNull();
  });

  it('omits the field entirely when asked to match by email', async () => {
    const writes = mockForm();
    await openForm();

    await userEvent.type(screen.getByLabelText('Login'), 'mokafor');
    await userEvent.type(screen.getByLabelText('Email'), 'm@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    // Omitted is what asks the server to match. Sending null would say
    // "service account", which is the opposite request.
    expect(writes[0]!.body).not.toHaveProperty('personId');
  });

  it('says when the chosen person is already placed somewhere', async () => {
    mockForm();
    await openForm();

    await userEvent.selectOptions(await screen.findByLabelText('Person'), 'p2');

    // Their own unit outranks this one and is not overwritten from here, so a
    // unit picked on this form would silently not apply to placement.
    expect(await screen.findByText(/already placed in Care/i)).toBeInTheDocument();
  });

  it('confirms a second account, naming the one they have', async () => {
    let refused = false;
    const writes = mockForm(() => {
      if (refused) return json({ id: 'u10' }, 201);
      refused = true;
      return json(
        {
          type: 'https://syntra.dev/problems/second-account',
          title: 'They already have an account',
          status: 409,
          detail: 'Kaycen Tyre already signs in as ktyre.',
          existingAccount: { id: 'u9', login: 'ktyre' },
        },
        409,
      );
    });
    await openForm();

    await userEvent.type(screen.getByLabelText('Login'), 'ktyre-admin');
    await userEvent.type(screen.getByLabelText('Email'), 'k2@acme.test');
    await userEvent.selectOptions(await screen.findByLabelText('Person'), 'p2');
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    expect(await screen.findByText(/already signs in as ktyre/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body).toMatchObject({
      personId: 'p2',
      allowSecondAccount: true,
    });
  });

  it('leaves an ordinary conflict as an error, not a question', async () => {
    mockForm(() =>
      json(
        {
          type: 'https://syntra.dev/problems/conflict',
          title: 'Conflict',
          status: 409,
          detail: 'login already exists: mokafor',
        },
        409,
      ),
    );
    await openForm();

    await userEvent.type(screen.getByLabelText('Login'), 'mokafor');
    await userEvent.type(screen.getByLabelText('Email'), 'm@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'New user' }));

    expect(await screen.findByText(/login already exists/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument();
  });
});
