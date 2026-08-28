import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GroupsPage } from './GroupsPage.js';

const GROUPS = [
  {
    id: 'g1',
    name: 'Ward Nurses',
    description: 'Everyone rostered on a ward',
    status: 'active',
    statusReason: null,
    sourceId: null,
  },
  {
    id: 'g2',
    name: 'Locums',
    description: null,
    status: 'inactive',
    statusReason: 'contract ended',
    sourceId: null,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const mockApi = (
  groups = GROUPS,
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
    return Promise.resolve(json({ groups }));
  }) as typeof fetch);

const renderPage = () =>
  render(
    <MemoryRouter>
      <GroupsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GroupsPage', () => {
  it('opens a group from its name', async () => {
    mockApi();
    renderPage();

    const link = await screen.findByRole('link', { name: 'Ward Nurses' });
    expect(link).toHaveAttribute('href', '/admin/groups/g1');
  });

  it('still says which groups grant nothing', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText(/contract ended/i)).toBeInTheDocument();
  });

  it('carries no per-group controls on a row', async () => {
    mockApi();
    renderPage();

    await screen.findByRole('link', { name: 'Ward Nurses' });
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /members/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /deactivate/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * The list used to fetch every account in the tenant to fill a picker inside
   * a panel opened from a row — whether or not anybody opened it.
   */
  it('reads groups and nothing else', async () => {
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByRole('link', { name: 'Ward Nurses' });
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]).includes('/api/admin/users')),
    ).toBe(false);
  });

  it('still creates a group, which acts on the collection rather than a member', async () => {
    const created = vi.fn((_url: string, _init?: RequestInit) => json({ id: 'g3' }));
    mockApi(GROUPS, {
      '/api/admin/groups': (url, init) =>
        init?.method === 'POST' ? created(url, init) : json({ groups: GROUPS }),
    });
    renderPage();

    await screen.findByRole('link', { name: 'Ward Nurses' });
    // The panel opens from a trigger carrying the same label as its submit.
    await userEvent.click(screen.getByRole('button', { name: /new group/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Porters');
    await userEvent.click(screen.getByRole('button', { name: /new group/i }));

    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(JSON.parse(String(created.mock.calls[0]![1]!.body)).name).toBe('Porters');
  });

  it('says there are no groups rather than showing an empty list', async () => {
    mockApi([]);
    renderPage();

    expect(await screen.findByText(/no groups yet/i)).toBeInTheDocument();
  });
});
