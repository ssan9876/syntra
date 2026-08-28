import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GroupDetailPage } from './GroupDetailPage.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const GROUP = {
  id: 'g1',
  name: 'Ward Nurses',
  description: 'Everyone rostered on a ward',
  status: 'active',
  statusReason: null,
  sourceId: null,
};

const MEMBERS = [
  { id: 'u1', login: 'mokafor', displayName: 'Maya Okafor', status: 'active' },
];

const ACCOUNTS = [
  { id: 'u1', login: 'mokafor', displayName: 'Maya Okafor' },
  { id: 'u2', login: 'jdoe', displayName: 'J Doe' },
];

const SOURCES = [{ id: 's1', name: 'Corporate LDAP' }];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockApi(
  group: Record<string, unknown> = GROUP,
  overrides: Record<string, (url: string, init?: RequestInit) => Response> = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (url.includes(fragment)) return Promise.resolve(handler(url, init));
    }
    if (url.includes('/sources')) return Promise.resolve(json({ sources: SOURCES }));
    if (url.includes('/audit')) {
      return Promise.resolve(json({ events: [], chainValid: true }));
    }
    if (url.includes('/members')) return Promise.resolve(json({ users: MEMBERS }));
    if (url.includes('/api/admin/users')) {
      return Promise.resolve(json({ users: ACCOUNTS }));
    }
    return Promise.resolve(json(group));
  }) as typeof fetch);
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/groups/g1']}>
      <Routes>
        <Route path="/admin/groups/:id" element={<GroupDetailPage />} />
        <Route path="/admin/groups" element={<div>the groups list</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
  granted.add('directory.read');
  granted.add('directory.write');
  granted.add('audit.read');
});

describe('GroupDetailPage', () => {
  it('reads the one group rather than every group in the tenant', async () => {
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByRole('heading', { name: 'Ward Nurses' });
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]).endsWith('/api/admin/groups/g1')),
    ).toBe(true);
  });

  it('identifies the group by its description', async () => {
    mockApi();
    renderPage();

    expect(
      await screen.findByText('Everyone rostered on a ward'),
    ).toBeInTheDocument();
  });

  it('names the directory that owns a synced group', async () => {
    mockApi({ ...GROUP, sourceId: 's1' });
    renderPage();

    expect(await screen.findByText('Corporate LDAP')).toBeInTheDocument();
  });

  /**
   * The one thing a group is FOR. It lived in a panel opened from a table row,
   * on a page that fetched every account in the tenant to fill its picker
   * whether or not anybody opened it.
   */
  describe('members', () => {
    it('lists the members, each opening its account', async () => {
      mockApi();
      renderPage();

      const link = await screen.findByRole('link', { name: 'Maya Okafor' });
      expect(link).toHaveAttribute('href', '/admin/users/u1');
    });

    it('adds a member and reloads the membership', async () => {
      const added = vi.fn((_url: string, _init?: RequestInit) => json({}));
      mockApi(GROUP, {
        '/members/u2': added,
        '/members': () => json({ users: MEMBERS }),
      });
      renderPage();

      await screen.findByRole('heading', { name: 'Ward Nurses' });
      await userEvent.selectOptions(screen.getByLabelText(/add a member/i), 'u2');
      await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => expect(added).toHaveBeenCalled());
      expect(added.mock.calls[0]![1]!.method).toBe('POST');
    });

    it('removes a member', async () => {
      const removed = vi.fn((_url: string, _init?: RequestInit) => json({}));
      mockApi(GROUP, {
        '/members/u1': removed,
        '/members': () => json({ users: MEMBERS }),
      });
      renderPage();

      await userEvent.click(
        await screen.findByRole('button', { name: /remove from group/i }),
      );

      await waitFor(() => expect(removed).toHaveBeenCalled());
      expect(removed.mock.calls[0]![1]!.method).toBe('DELETE');
    });

    it('reports a refused membership change rather than appearing to succeed', async () => {
      mockApi(GROUP, {
        '/members/u1': () =>
          json({ title: 'Nope', detail: 'That membership could not be changed.' }, 409),
        '/members': () => json({ users: MEMBERS }),
      });
      renderPage();

      await userEvent.click(
        await screen.findByRole('button', { name: /remove from group/i }),
      );

      expect(
        await screen.findByText(/could not be changed/i),
      ).toBeInTheDocument();
    });

    it('says nobody is in the group rather than showing an empty list', async () => {
      mockApi(GROUP, { '/members': () => json({ users: [] }) });
      renderPage();

      await screen.findByRole('heading', { name: 'Ward Nurses' });
      expect(await screen.findByText(/nobody is in this group/i)).toBeInTheDocument();
    });

    /**
     * `directory.read` gates the account list the picker is built from, and a
     * caller can administer groups without holding it. Swallowing that read's
     * error renders an empty picker that reads as "there is nobody to add",
     * which is a false statement about the tenant rather than a gap.
     *
     * The same refusal is named the same way on the roles screen. Two screens
     * giving one answer is worth more than either finding better words alone.
     */
    it('names the permission when the account list cannot be read', async () => {
      mockApi(GROUP, {
        '/api/admin/users': () =>
          json({ title: 'Forbidden', detail: 'Forbidden', status: 403 }, 403),
        '/members': () => json({ users: MEMBERS }),
      });
      renderPage();

      await screen.findByRole('heading', { name: 'Ward Nurses' });
      expect(
        await screen.findByText(/adding a member needs directory.read/i),
      ).toBeInTheDocument();
    });
  });

  describe('editing', () => {
    it('saves the name and description', async () => {
      const patched = vi.fn((_url: string, _init?: RequestInit) => json(GROUP));
      mockApi(GROUP, {
        '/api/admin/groups/g1': (_url, init) =>
          init?.method === 'PATCH' ? patched(_url, init) : json(GROUP),
      });
      renderPage();

      await screen.findByRole('heading', { name: 'Ward Nurses' });
      await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      const name = screen.getByLabelText(/^name$/i);
      await userEvent.clear(name);
      await userEvent.type(name, 'Ward Staff');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(patched).toHaveBeenCalled());
      const body = JSON.parse(String(patched.mock.calls[0]![1]!.body));
      expect(body.name).toBe('Ward Staff');
    });

    it('offers no edit for a group a directory owns', async () => {
      mockApi({ ...GROUP, sourceId: 's1' });
      renderPage();

      await screen.findByRole('heading', { name: 'Ward Nurses' });
      expect(
        screen.queryByRole('button', { name: /^edit$/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('status', () => {
    it('says what deactivating the group does to its members', async () => {
      mockApi();
      renderPage();

      await userEvent.click(
        await screen.findByRole('button', { name: /deactivate/i }),
      );
      expect(screen.getByText(/members are kept/i)).toBeInTheDocument();
    });
  });

  it('shows the group’s own log', async () => {
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByRole('heading', { name: 'Ward Nurses' });
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes('subject=g1')),
      ).toBe(true),
    );
  });

  it('reports a missing group instead of rendering an empty one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) =>
      String(input).includes('/api/admin/groups/g1')
        ? Promise.resolve(
            json({ title: 'Not found', detail: 'Group not found', status: 404 }, 404),
          )
        : Promise.resolve(json({ sources: [] }))) as typeof fetch);
    renderPage();

    expect(await screen.findByText(/group not found/i)).toBeInTheDocument();
  });

  it('offers a way back to the list', async () => {
    mockApi();
    renderPage();

    const back = await screen.findByRole('link', { name: /back to groups/i });
    expect(back).toHaveAttribute('href', '/admin/groups');
  });
});
