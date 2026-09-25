import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Portal } from './Portal.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let userId = 'u1';
vi.mock('../session/SessionProvider.js', () => ({
  useSession: () => ({ session: { displayName: 'Ada Lovelace', userId } }),
}));

let brand: Record<string, unknown> = {};
vi.mock('../branding/BrandProvider.js', () => ({
  useBrand: () => ({
    name: null,
    logo: null,
    primary: null,
    accent: null,
    supportUrl: null,
    supportLabel: null,
    ...brand,
  }),
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
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
    Promise.resolve(
      String(input).endsWith('/launch')
        ? json({ status: 'launch', url: 'https://app.example.test/' })
        : json({ applications }),
    ),
  );

const headings = async () =>
  (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent);

const renderPortal = () =>
  render(
    <MemoryRouter>
      <Portal />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  userId = 'u1';
  brand = {};
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

describe('Portal tile icons', () => {
  it("shows the application's self-hosted logo, unannounced beside its name", async () => {
    mockTiles([tile({ iconUrl: '/app-icons/finance.svg' })]);
    const { container } = renderPortal();
    await screen.findByText('Payroll');
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/app-icons/finance.svg');
    // The name is written beside it; "Payroll logo, Payroll" is the name twice.
    expect(img).toHaveAttribute('alt', '');
  });

  it('falls back to the monogram when the logo will not load', async () => {
    mockTiles([tile({ name: 'Payroll Hub', iconUrl: '/api/portal/applications/t1/icon?v=abc' })]);
    const { container } = renderPortal();
    await screen.findByText('Payroll Hub');
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('PH')).toBeInTheDocument();
  });

  it('never requests a remote logo the security policy would block', async () => {
    mockTiles([tile({ name: 'Payroll Hub', iconUrl: 'https://cdn.example.test/p.png' })]);
    const { container } = renderPortal();
    await screen.findByText('Payroll Hub');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('PH')).toBeInTheDocument();
  });

  it('does not point an image at a javascript: URL', async () => {
    mockTiles([tile({ iconUrl: 'javascript:alert(1)' })]);
    const { container } = renderPortal();
    await screen.findByText('Payroll');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('Pinned and recently used', () => {
  it('pins a tile into a row of its own, and remembers it for this user', async () => {
    mockTiles([tile(), tile({ id: 't2', name: 'Expenses' })]);
    renderPortal();

    await userEvent.click(await screen.findByRole('button', { name: 'Pin Expenses' }));

    expect(await headings()).toEqual(['Pinned', 'All applications']);
    const pinned = screen.getByRole('heading', { name: 'Pinned' }).closest('section')!;
    expect(within(pinned).getByText('Expenses')).toBeInTheDocument();
    expect(within(pinned).queryByText('Payroll')).toBeNull();
    expect(JSON.parse(localStorage.getItem('syntra.portal.pinned.u1')!)).toEqual(['t2']);
  });

  it('keeps the pin a sibling of the launch button, never inside it', async () => {
    // A control inside a button is invalid, is flattened into one control by
    // a screen reader, and turns a tap on the pin into a launch.
    mockTiles([tile()]);
    renderPortal();
    const pin = await screen.findByRole('button', { name: 'Pin Payroll' });
    expect(pin.parentElement!.closest('button')).toBeNull();
  });

  it('unpins, and the row goes away when it is empty', async () => {
    localStorage.setItem('syntra.portal.pinned.u1', JSON.stringify(['t1']));
    mockTiles([tile(), tile({ id: 't2', name: 'Expenses' })]);
    renderPortal();

    const [unpin] = await screen.findAllByRole('button', { name: 'Unpin Payroll' });
    await userEvent.click(unpin!);

    await waitFor(() => expect(screen.queryByRole('heading', { level: 2 })).toBeNull());
    expect(JSON.parse(localStorage.getItem('syntra.portal.pinned.u1')!)).toEqual([]);
  });

  it("does not show one person's pins to the next person on a shared PC", async () => {
    localStorage.setItem('syntra.portal.pinned.u1', JSON.stringify(['t1']));
    userId = 'u2';
    mockTiles([tile(), tile({ id: 't2', name: 'Expenses' })]);
    renderPortal();
    await screen.findByText('Payroll');
    expect(screen.queryByRole('heading', { name: 'Pinned' })).toBeNull();
  });

  it('skips a pinned application that is no longer assigned', async () => {
    localStorage.setItem('syntra.portal.pinned.u1', JSON.stringify(['gone']));
    mockTiles([tile()]);
    renderPortal();
    await screen.findByText('Payroll');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('lists what was just opened under Recently used', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    mockTiles([tile(), tile({ id: 't2', name: 'Expenses' })]);
    renderPortal();

    await userEvent.click(await screen.findByRole('button', { name: /^Expenses/ }));

    expect(await headings()).toEqual(['Recently used', 'All applications']);
    expect(JSON.parse(localStorage.getItem('syntra.portal.recent.u1')!)).toEqual(['t2']);
  });

  it('shows at most four recent applications, newest first', async () => {
    localStorage.setItem(
      'syntra.portal.recent.u1',
      JSON.stringify(['a5', 'a4', 'a3', 'a2', 'a1']),
    );
    mockTiles(['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => tile({ id, name: `App ${id}` })));
    renderPortal();

    const recent = (await screen.findByRole('heading', { name: 'Recently used' })).closest(
      'section',
    )!;
    const names = within(recent)
      .getAllByRole('button', { name: /^App / })
      .map((b) => within(b).getByText(/^App /).textContent);
    expect(names).toEqual(['App a5', 'App a4', 'App a3', 'App a2']);
  });

  it('still renders when browser storage throws', async () => {
    // A private window, or a policy that blocks storage. The shortcuts are a
    // convenience; the tiles are the portal.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    mockTiles([tile()]);
    renderPortal();

    await userEvent.click(await screen.findByRole('button', { name: 'Pin Payroll' }));
    expect(await headings()).toEqual(['Pinned', 'All applications']);
  });
});

describe('Portal filter', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => tile({ id: `t${i}`, name: `App ${i}` }));

  it('offers no filter for a dozen tiles or fewer', async () => {
    mockTiles(many(12));
    renderPortal();
    await screen.findByText('App 0');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('filters a long list, and says so when nothing matches', async () => {
    mockTiles([...many(12), tile({ id: 'x', name: 'Payroll', description: 'Salaries' })]);
    renderPortal();

    const box = await screen.findByRole('searchbox', { name: 'Filter applications' });
    await userEvent.type(box, 'salar');
    expect(screen.getByText('Payroll')).toBeInTheDocument();
    expect(screen.queryByText('App 0')).toBeNull();

    await userEvent.clear(box);
    await userEvent.type(box, 'zzz');
    expect(screen.getByText('No applications match “zzz”')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getByText('App 0')).toBeInTheDocument();
  });
});

describe('Portal help', () => {
  it("links to the tenant's help desk beside the greeting", async () => {
    brand = { supportUrl: 'https://help.acme.test/', supportLabel: null };
    mockTiles([tile()]);
    renderPortal();
    const link = await screen.findByRole('link', { name: 'Get help' });
    expect(link).toHaveAttribute('href', 'https://help.acme.test/');
  });

  it('shows no help link when the tenant has not set one', async () => {
    mockTiles([tile()]);
    renderPortal();
    await screen.findByText('Payroll');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
