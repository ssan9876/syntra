import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
