import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Portal } from './Portal.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

vi.mock('../session/SessionProvider.js', () => ({
  useSession: () => ({ session: { displayName: 'Ada Lovelace' } }),
}));

vi.mock('../components/AppShell.js', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const tile = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Payroll',
  slug: 'payroll',
  description: null,
  iconUrl: null,
  category: null,
  ...over,
});

const mockTiles = (applications: unknown[]) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(json({ applications })));

const renderPortal = () =>
  render(
    <MemoryRouter>
      <Portal />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Portal tiles', () => {
  it('shows no heading when everything sits in one group', async () => {
    // "General" above every tile a small organisation has is a word that says
    // nothing, on a screen people look at for four seconds.
    mockTiles([tile(), tile({ id: 't2', name: 'Expenses' })]);
    renderPortal();

    expect(await screen.findByText('Payroll')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('groups tiles under their categories', async () => {
    mockTiles([
      tile({ id: 't1', name: 'Payroll', category: 'Finance' }),
      tile({ id: 't2', name: 'Repos', category: 'Engineering' }),
    ]);
    renderPortal();

    const headings = (await screen.findAllByRole('heading', { level: 2 })).map(
      (h) => h.textContent,
    );
    // Ordered by name, not by tile count: a page whose headings move when
    // somebody is assigned an application is a page nobody can learn.
    expect(headings).toEqual(['Engineering', 'Finance']);
  });

  it('puts uncategorised tiles last, under their own heading', async () => {
    // Somebody who categorised most of their applications has said what the
    // important groups are; the remainder is the leftover.
    mockTiles([
      tile({ id: 't1', name: 'Misc', category: null }),
      tile({ id: 't2', name: 'Payroll', category: 'Finance' }),
    ]);
    renderPortal();

    const headings = (await screen.findAllByRole('heading', { level: 2 })).map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(['Finance', 'Everything else']);
  });

  it('treats a blank category as no category', async () => {
    mockTiles([
      tile({ id: 't1', name: 'Payroll', category: '   ' }),
      tile({ id: 't2', name: 'Repos', category: 'Engineering' }),
    ]);
    renderPortal();

    const headings = (await screen.findAllByRole('heading', { level: 2 })).map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(['Engineering', 'Everything else']);
  });

  it('still says so when nothing is assigned', async () => {
    mockTiles([]);
    renderPortal();
    expect(await screen.findByText(/no applications assigned yet/i)).toBeInTheDocument();
  });
});
