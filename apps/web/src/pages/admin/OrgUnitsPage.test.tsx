import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OrgUnitsPage } from './OrgUnitsPage.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const UNITS = [
  {
    id: 'o0',
    name: 'Head Office',
    parentId: null,
    status: 'active',
    statusReason: null,
    sourceId: null,
  },
  {
    id: 'o1',
    name: 'Finance',
    parentId: 'o0',
    status: 'inactive',
    statusReason: 'department closed',
    sourceId: null,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const mockApi = (
  units = UNITS,
  overrides: Record<string, (url: string, init?: RequestInit) => Response> = {},
) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (url.includes(fragment)) return Promise.resolve(handler(url, init));
    }
    return Promise.resolve(json({ orgUnits: units }));
  }) as typeof fetch);

const renderPage = () =>
  render(
    <MemoryRouter>
      <OrgUnitsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
  granted.add('directory.read');
  granted.add('directory.write');
  granted.add('directory.delete');
});

/**
 * A node in a tree is a row, and a row opens a record.
 *
 * The tree used to carry every control a unit had — edit, deactivate, delete —
 * so clicking a unit did nothing and the controls sat next to a name with no
 * room to say what they were about to do.
 */
describe('OrgUnitsPage', () => {
  it('opens a unit from its name', async () => {
    mockApi();
    renderPage();

    const link = await screen.findByRole('link', { name: 'Head Office' });
    expect(link).toHaveAttribute('href', '/admin/org-units/o0');
  });

  it('keeps the hierarchy: a child is reachable and nested under its parent', async () => {
    mockApi();
    renderPage();

    const child = await screen.findByRole('link', { name: 'Finance' });
    expect(child).toHaveAttribute('href', '/admin/org-units/o1');
    // The nesting is the point of drawing a tree rather than a table: an
    // administrator scoping a role to a unit needs to see what sits beneath it.
    const parentItem = screen
      .getByRole('link', { name: 'Head Office' })
      .closest('li');
    expect(parentItem).toContainElement(child);
  });

  it('still says which units grant nothing', async () => {
    mockApi();
    renderPage();

    // Labelled, not hidden. A deactivated unit keeps its name, its place in the
    // tree and the users sitting in it.
    expect(await screen.findByText(/department closed/i)).toBeInTheDocument();
  });

  it('carries no per-unit controls on a row', async () => {
    mockApi();
    renderPage();

    await screen.findByRole('link', { name: 'Head Office' });
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /deactivate/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('still creates a unit, which acts on the collection rather than a member', async () => {
    const created = vi.fn((_url: string, _init?: RequestInit) => json({ id: 'o2' }));
    mockApi(UNITS, {
      '/api/admin/org-units': (url, init) =>
        init?.method === 'POST' ? created(url, init) : json({ orgUnits: UNITS }),
    });
    renderPage();

    await screen.findByRole('link', { name: 'Head Office' });
    // The panel opens from a trigger carrying the same label as its submit.
    await userEvent.click(screen.getByRole('button', { name: /new org unit/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Payroll');
    await userEvent.click(screen.getByRole('button', { name: /new org unit/i }));

    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(JSON.parse(String(created.mock.calls[0]![1]!.body)).name).toBe('Payroll');
  });

  it('says the directory is empty rather than showing an empty tree', async () => {
    mockApi([]);
    renderPage();

    expect(await screen.findByText(/no org units yet/i)).toBeInTheDocument();
  });

  it('materialises nothing, and asks nothing about containers, to draw the list', async () => {
    // Two decisions, two controls. Creating a unit in Syntra writes nothing to
    // any directory, and that separation is what Ruling P9 (revised) rests on.
    // The list now asks for neither targets nor containers at all: both moved
    // to the record with the panel that reads them.
    const urls: string[] = [];
    mockApi(UNITS, {
      '/api/admin/': (url) => {
        urls.push(url);
        return json({ orgUnits: UNITS });
      },
    });
    renderPage();

    await screen.findByRole('link', { name: 'Head Office' });

    expect(urls.some((u) => u.includes('containers'))).toBe(false);
    expect(urls.some((u) => u.includes('targets'))).toBe(false);
  });
});
