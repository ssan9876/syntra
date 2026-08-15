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
  },
  {
    id: 'u2',
    login: 'sroe',
    displayName: 'S Roe',
    email: 's@acme.test',
    status: 'inactive',
    statusReason: 'left the company',
  },
];

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
});
