import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PersonDetailPage } from './PersonDetailPage.js';

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
