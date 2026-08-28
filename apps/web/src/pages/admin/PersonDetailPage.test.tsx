import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PersonDetailPage } from './PersonDetailPage.js';

// Without a provider `useCan` answers false, which would hide the person's own
// log on every test in this file. Granting everything keeps the subject of
// these tests the SCREEN rather than the permission model, which has its own.
vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => () => true,
}));

const person = {
  id: 'p1',
  givenName: 'Jo',
  familyName: 'Doe',
  businessEmail: 'jo@acme.test',
  externalId: 'E1',
  status: 'active',
  contracts: [
    {
      id: 'c1',
      sequence: 1,
      isPrimary: true,
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: null,
      jobTitle: 'Nurse',
      department: 'Care',
    },
    {
      id: 'c2',
      sequence: 2,
      isPrimary: false,
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: null,
      jobTitle: 'Trainer',
      department: 'Learning',
    },
  ],
  users: [{ id: 'u1', login: 'jdoe', status: 'active' }],
  orgUnitId: null,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

const noContent = () => new Response(null, { status: 204 }) as never;

/**
 * Routes the stubbed fetch by path.
 *
 * The blanket `mockResolvedValue` the older tests use answers every request
 * with the same body, which is fine while a page reads one resource and writes
 * nothing. These tests assert what was POSTed, so they need to tell the person
 * read apart from the contract write.
 */
function mockRoutes(
  handlers: Record<string, (init: RequestInit | undefined) => Response>,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const handler = handlers[url];
    if (!handler) return Promise.reject(new Error(`unmocked fetch: ${url}`));
    return Promise.resolve(handler(init));
  }) as never);
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/people/p1']}>
      <Routes>
        <Route path="/admin/people/:id" element={<PersonDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('PersonDetailPage', () => {
  it('shows every contract, not only the primary one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person));
    renderPage();

    expect(await screen.findByText('Nurse')).toBeInTheDocument();
    expect(screen.getByText('Trainer')).toBeInTheDocument();
  });

  it('marks which contract is primary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person));
    renderPage();

    const row = (await screen.findByText('Nurse')).closest('tr')!;
    expect(row).toHaveTextContent(/primary/i);
  });

  it('shows an open-ended contract as ongoing rather than blank', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person));
    renderPage();

    const row = (await screen.findByText('Nurse')).closest('tr')!;
    expect(row).toHaveTextContent(/ongoing/i);
  });

  it('lists the accounts linked to the person', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person));
    renderPage();

    expect(await screen.findByText('jdoe')).toBeInTheDocument();
  });

  it('explains an empty contract list rather than showing a bare table', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ ...person, contracts: [] }),
    );
    renderPage();

    expect(await screen.findByText(/no contracts recorded/i)).toBeInTheDocument();
  });

  it('explains when nobody can sign in as this person', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ...person, users: [] }));
    renderPage();

    expect(await screen.findByText(/no accounts linked/i)).toBeInTheDocument();
  });

  it('offers a contract form and posts what was typed', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    mockRoutes({
      '/api/admin/persons/p1': () => json({ ...person, contracts: [] }),
      '/api/admin/users': () => json({ users: [] }),
      '/api/admin/persons/p1/contracts': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        return json({ id: 'c9' });
      },
    });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Add contract' }));
    await user.type(screen.getByLabelText('Job title'), 'Staff Nurse');
    await user.type(screen.getByLabelText('Department'), 'Nursing');
    await user.type(screen.getByLabelText('Start date'), '2026-09-01');
    await user.click(screen.getByRole('button', { name: 'Add contract' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      // The person had no contracts, so this is their first and therefore
      // their primary one.
      sequence: 1,
      isPrimary: true,
      startDate: '2026-09-01',
      jobTitle: 'Staff Nurse',
      department: 'Nursing',
    });
  });

  it('numbers a second contract past the first and does not claim primary twice', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    mockRoutes({
      // `person` already holds sequences 1 and 2, and 1 is primary.
      '/api/admin/persons/p1': () => json(person),
      '/api/admin/users': () => json({ users: [] }),
      '/api/admin/persons/p1/contracts': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        return json({ id: 'c9' });
      },
    });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Add contract' }));
    await user.type(screen.getByLabelText('Start date'), '2026-09-01');
    await user.click(screen.getByRole('button', { name: 'Add contract' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    // A duplicate sequence and a second primary are both 409s from the API.
    expect(posted[0]).toMatchObject({ sequence: 3, isPrimary: false });
  });

  it('links an existing unlinked account to the person', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    mockRoutes({
      '/api/admin/persons/p1': () => json({ ...person, users: [] }),
      '/api/admin/users': () =>
        json({
          users: [
            { id: 'u1', login: 'mokafor', personId: null, status: 'active' },
            { id: 'u2', login: 'taken', personId: 'p9', status: 'active' },
          ],
        }),
      '/api/admin/persons/p1/link-user': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        return noContent();
      },
    });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Link an account' }));

    const picker = screen.getByLabelText('Account');
    // An account already belonging to somebody else is not offered: linking
    // it would silently move it off them.
    expect(within(picker).queryByText('taken')).not.toBeInTheDocument();
    expect(within(picker).getByText('mokafor')).toBeInTheDocument();

    await user.selectOptions(picker, 'u1');
    await user.click(screen.getByRole('button', { name: 'Link an account' }));

    await waitFor(() => expect(posted).toEqual([{ userId: 'u1' }]));
  });

  /**
   * The person's own attributes, editable where the person is.
   *
   * These had a form on the LIST — a slide-in panel opened by a row — and none
   * on the record itself. So the screen that showed everything about somebody
   * was the one screen on which nothing about them could be changed, and
   * correcting a misspelt name meant going back to a table and finding the row
   * again.
   */
  it('edits the person from their own screen', async () => {
    const user = userEvent.setup();
    const patched: unknown[] = [];
    mockRoutes({
      '/api/admin/persons/p1': (init) => {
        if (init?.method === 'PATCH') {
          patched.push(JSON.parse(String(init.body)));
          return json(person);
        }
        return json(person);
      },
      '/api/admin/users': () => json({ users: [] }),
    });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const given = screen.getByLabelText('Given name');
    await user.clear(given);
    await user.type(given, 'Joanne');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({ givenName: 'Joanne', familyName: 'Doe' });
  });

  it('clears an emptied field rather than leaving the old value', async () => {
    const user = userEvent.setup();
    const patched: Record<string, unknown>[] = [];
    mockRoutes({
      '/api/admin/persons/p1': (init) => {
        if (init?.method === 'PATCH') {
          patched.push(JSON.parse(String(init.body)));
        }
        return json(person);
      },
      '/api/admin/users': () => json({ users: [] }),
    });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Business email'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // NULL clears; omitting the key would mean "leave alone", and an emptied
    // box would silently keep the old address.
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]!['businessEmail']).toBeNull();
  });

  /**
   * Only while there is something to break. On a person with no source
   * reference there is nothing an import matches on yet, and a warning about
   * breaking it would be a hint by another name.
   */
  it('warns that changing the source reference splits the person in two', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/admin/persons/p1': () => json(person),
      '/api/admin/users': () => json({ users: [] }),
    });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(
      screen.getByText(/create a second person rather than update this one/i),
    ).toBeInTheDocument();
  });

  it('opens each linked account on its own screen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person));
    renderPage();

    expect(await screen.findByRole('link', { name: 'jdoe' })).toHaveAttribute(
      'href',
      '/admin/users/u1',
    );
  });

  it('deactivates the person, saying what it does and does not touch', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    // Sign-in accounts are a separate object with a separate status, and an
    // administrator who assumes otherwise leaves a leaver able to sign in.
    expect(
      screen.getByText(/sign-in accounts are not changed/i),
    ).toBeInTheDocument();
  });

  /**
   * A person's history is their own record AND every account linked to them.
   * Asking only about the person id would hide every sign-in, lockout and
   * password reset, which is most of what there is to see.
   */
  it('asks for the log of the person and of their accounts', async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.includes('/audit')) return Promise.resolve(json({ events: [], chainValid: true }));
      return Promise.resolve(json(person));
    }) as never);

    renderPage();

    await waitFor(() =>
      expect(asked.some((url) => url.includes('/audit'))).toBe(true),
    );
    const audit = asked.find((url) => url.includes('/audit'))!;
    expect(audit).toContain('subject=p1');
    expect(audit).toContain('subject=u1');
  });

  it('says why it cannot link when every account already belongs to somebody', async () => {
    mockRoutes({
      '/api/admin/persons/p1': () => json({ ...person, users: [] }),
      '/api/admin/users': () =>
        json({ users: [{ id: 'u2', login: 'taken', personId: 'p9', status: 'active' }] }),
    });

    renderPage();

    // Disabled with the reason beside it, rather than a control that opens
    // onto an empty picker.
    expect(
      await screen.findByText(/every account already belongs to somebody/i),
    ).toBeInTheDocument();
  });
});

describe('PersonDetailPage org unit assignment', () => {
  const orgUnits = {
    orgUnits: [
      { id: 'ou-1', name: 'Sales', status: 'active' },
      { id: 'ou-2', name: 'Closed', status: 'inactive' },
    ],
  };

  const routes = (onPatch?: (init: RequestInit | undefined) => void) => ({
    '/api/admin/persons/p1': (init: RequestInit | undefined) => {
      if (init?.method === 'PATCH') {
        onPatch?.(init);
        return json({ ...person, orgUnitId: 'ou-1' });
      }
      return json(person);
    },
    '/api/admin/users': () => json({ users: [] }),
    '/api/admin/org-units': () => json(orgUnits),
  });

  it('sends the chosen unit on save', async () => {
    let body: string | undefined;
    mockRoutes(routes((init) => { body = String(init?.body); }));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/org unit/i), 'ou-1');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(JSON.parse(body!).orgUnitId).toBe('ou-1');
  });

  it('sends null when the selection is cleared', async () => {
    // NULL sends them back to the account profile's template. Omitting the
    // field would mean "leave alone", so an emptied selector would silently
    // keep the old unit -- the same trap the e-mail fields document.
    let body: string | undefined;
    mockRoutes({
      ...routes((init) => { body = String(init?.body); }),
      '/api/admin/persons/p1': (init: RequestInit | undefined) => {
        if (init?.method === 'PATCH') {
          body = String(init.body);
          return json({ ...person, orgUnitId: null });
        }
        return json({ ...person, orgUnitId: 'ou-1' });
      },
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/org unit/i), '');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(JSON.parse(body!).orgUnitId).toBeNull();
  });

  it('does not offer a deactivated unit', async () => {
    // A deactivated unit grants nothing and is not somewhere to put anybody.
    mockRoutes(routes());
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const select = await screen.findByLabelText(/org unit/i);

    expect(within(select).getByRole('option', { name: 'Sales' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Closed' })).toBeNull();
  });
});

/**
 * Correcting a contract, from the screen that shows it.
 *
 * The fields were rendered read-only and the only way to change one was to add
 * a SECOND contract, which records a different fact about the person.
 */
describe('PersonDetailPage contract editing', () => {
  it('opens an edit form on a contract row, prefilled from that row', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person));
    renderPage();

    await screen.findByText('Nurse');
    await userEvent.click(
      screen.getByRole('button', { name: /edit contract 1/i }),
    );

    expect(await screen.findByLabelText('Department')).toHaveValue('Care');
    expect(screen.getByLabelText('Job title')).toHaveValue('Nurse');
  });

  it('names each edit button by its sequence rather than repeating "Edit"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person));
    renderPage();

    await screen.findByText('Nurse');
    // A table of identical "Edit" buttons is announced one after another with
    // no way to tell which row the reader is on.
    expect(
      screen.getByRole('button', { name: /edit contract 1/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /edit contract 2/i }),
    ).toBeInTheDocument();
  });

  it('patches the sequence it was opened on', async () => {
    let body: unknown;
    mockRoutes({
      '/api/admin/persons/p1': () => json(person),
      '/api/admin/persons/p1/contracts/2': (init) => {
        body = JSON.parse(String(init?.body));
        return json({ ...person.contracts[1], department: 'Training' });
      },
    });
    renderPage();

    await screen.findByText('Trainer');
    await userEvent.click(
      screen.getByRole('button', { name: /edit contract 2/i }),
    );
    const department = await screen.findByLabelText('Department');
    await userEvent.clear(department);
    await userEvent.type(department, 'Training');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ department: 'Training' });
  });

  it('clears a field that was emptied rather than dropping it', async () => {
    let body: Record<string, unknown> | undefined;
    mockRoutes({
      '/api/admin/persons/p1': () => json(person),
      '/api/admin/persons/p1/contracts/1': (init) => {
        body = JSON.parse(String(init?.body));
        return json({ ...person.contracts[0], jobTitle: null });
      },
    });
    renderPage();

    await screen.findByText('Nurse');
    await userEvent.click(
      screen.getByRole('button', { name: /edit contract 1/i }),
    );
    await userEvent.clear(await screen.findByLabelText('Job title'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // An emptied box means "there is no job title", not "leave it alone".
    // Dropping it would make a field uncorrectable in the direction of
    // removing it.
    await waitFor(() => expect(body).toBeDefined());
    expect(body!.jobTitle).toBeNull();
  });
});
