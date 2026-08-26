import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
});

describe('linking an account to a person', () => {
  /**
   * `POST /persons/:id/link-user` existed and nothing called it, while the
   * empty state on this very panel said "This person exists in the directory
   * but cannot sign in. Link an account to give them access." -- with no
   * control that would.
   */
  const mockPerson = (over: { users?: unknown[]; candidates?: unknown[] } = {}) => {
    const sent: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return Promise.resolve(json({}));
      }
      if (url.includes('/api/admin/users')) {
        return Promise.resolve(json({ users: over.candidates ?? [] }));
      }
      return Promise.resolve(json({ ...person, users: over.users ?? person.users }));
    });
    return sent;
  };

  it('offers unlinked users and posts the link', async () => {
    const sent = mockPerson({
      users: [],
      // `personId: null` is what makes an account a CANDIDATE: an account
      // already attached to somebody else is not one to offer here.
      candidates: [
        { id: 'u9', login: 'mokafor', displayName: 'Maya Okafor', personId: null },
        { id: 'u8', login: 'taken', displayName: 'Someone Else', personId: 'p2' },
      ],
    });
    renderPage();
    await screen.findByText('No accounts linked');

    await userEvent.selectOptions(screen.getByLabelText('Account to link'), 'u9');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain('/api/admin/persons/p1/link-user');
    expect(sent[0]!.body).toEqual({ userId: 'u9' });
  });

  it('does not offer an account that already belongs to somebody', async () => {
    mockPerson({
      users: [],
      candidates: [{ id: 'u8', login: 'taken', displayName: 'Someone Else', personId: 'p2' }],
    });
    renderPage();
    await screen.findByText('No accounts linked');

    const picker = screen.getByLabelText('Account to link');
    expect(picker).not.toHaveTextContent('taken');
  });
});
