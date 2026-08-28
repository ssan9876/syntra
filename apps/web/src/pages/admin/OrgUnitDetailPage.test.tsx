import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OrgUnitDetailPage } from './OrgUnitDetailPage.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const UNIT = {
  id: 'o1',
  name: 'Finance',
  parentId: 'o0',
  status: 'active',
  statusReason: null,
  sourceId: null,
  parent: { id: 'o0', name: 'Head Office' },
  users: [
    { id: 'u1', login: 'mokafor', displayName: 'Maya Okafor', status: 'active' },
  ],
  children: [{ id: 'o2', name: 'Payroll', status: 'active' }],
};

const SOURCES = [{ id: 's1', name: 'Corporate LDAP' }];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

/**
 * Routes the stubbed fetch by path, as the account page's tests do.
 *
 * The record reads three resources and writes to three endpoints, so a blanket
 * `mockResolvedValue` would answer a PATCH with the unit body and hide what the
 * form actually sent.
 */
function mockApi(
  unit: Record<string, unknown> = UNIT,
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
    // The list, fetched only to populate the move form's parent options.
    if (url.endsWith('/api/admin/org-units')) {
      return Promise.resolve(
        json({
          orgUnits: [
            { id: 'o0', name: 'Head Office' },
            { id: 'o1', name: 'Finance' },
            { id: 'o2', name: 'Payroll' },
          ],
        }),
      );
    }
    return Promise.resolve(json(unit));
  }) as typeof fetch);
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/org-units/o1']}>
      <Routes>
        <Route path="/admin/org-units/:id" element={<OrgUnitDetailPage />} />
        <Route path="/admin/org-units" element={<div>the org units list</div>} />
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

describe('OrgUnitDetailPage', () => {
  it('reads the one unit rather than the whole directory', async () => {
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByRole('heading', { name: 'Finance' });
    expect(
      fetchSpy.mock.calls.some((c) =>
        String(c[0]).endsWith('/api/admin/org-units/o1'),
      ),
    ).toBe(true);
  });

  it('links up to its parent by name', async () => {
    mockApi();
    renderPage();

    const link = await screen.findByRole('link', { name: 'Head Office' });
    expect(link).toHaveAttribute('href', '/admin/org-units/o0');
  });

  it('says a top-level unit sits at the top rather than showing no parent', async () => {
    mockApi({ ...UNIT, parentId: null, parent: null });
    renderPage();

    await screen.findByRole('heading', { name: 'Finance' });
    expect(screen.getByText(/top level/i)).toBeInTheDocument();
  });

  /**
   * The half of the record the list could not show. The emptiness rule refuses
   * a delete on exactly these two collections, so seeing them is seeing why the
   * delete will be refused — before clicking it.
   */
  it('lists the users sitting in the unit, each opening its account', async () => {
    mockApi();
    renderPage();

    const link = await screen.findByRole('link', { name: 'Maya Okafor' });
    expect(link).toHaveAttribute('href', '/admin/users/u1');
    expect(screen.getByText('mokafor')).toBeInTheDocument();
  });

  it('lists the units beneath it, each opening its own record', async () => {
    mockApi();
    renderPage();

    const link = await screen.findByRole('link', { name: 'Payroll' });
    expect(link).toHaveAttribute('href', '/admin/org-units/o2');
  });

  it('shows a deactivated member rather than hiding one that blocks the delete', async () => {
    mockApi({
      ...UNIT,
      users: [
        { id: 'u2', login: 'leaver', displayName: 'A Leaver', status: 'inactive' },
      ],
    });
    renderPage();

    await screen.findByRole('link', { name: 'A Leaver' });
    expect(screen.getByText(/inactive/i)).toBeInTheDocument();
  });

  it('says an empty unit is empty', async () => {
    mockApi({ ...UNIT, users: [], children: [] });
    renderPage();

    await screen.findByRole('heading', { name: 'Finance' });
    expect(screen.getByText(/nobody is in this unit/i)).toBeInTheDocument();
  });

  describe('editing', () => {
    it('renames the unit and moves it', async () => {
      const patched = vi.fn((_url: string, _init?: RequestInit) => json(UNIT));
      mockApi(UNIT, {
        '/api/admin/org-units/o1': (_url, init) =>
          init?.method === 'PATCH' ? patched(_url, init) : json(UNIT),
      });
      renderPage();

      await screen.findByRole('heading', { name: 'Finance' });
      await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      const name = screen.getByLabelText(/name/i);
      await userEvent.clear(name);
      await userEvent.type(name, 'Group Finance');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(patched).toHaveBeenCalled());
      const body = JSON.parse(String(patched.mock.calls[0]![1]!.body));
      expect(body.name).toBe('Group Finance');
      // NULL means top level. Omitting would mean "leave alone", so a unit
      // could never be moved out of its parent.
      expect(body).toHaveProperty('parentId');
    });

    it('never offers the unit itself as its own parent', async () => {
      mockApi();
      renderPage();

      await screen.findByRole('heading', { name: 'Finance' });
      await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));

      const parent = await screen.findByLabelText(/parent/i);
      const options = [...parent.querySelectorAll('option')].map((o) => o.value);
      expect(options).toContain('o0');
      expect(options).not.toContain('o1');
    });

    /**
     * The next sync run reads the unit out of the directory and writes it back,
     * so the form would offer a change that silently reverts.
     */
    it('offers no edit for a unit a directory owns, and says who owns it', async () => {
      mockApi({ ...UNIT, sourceId: 's1' });
      renderPage();

      await screen.findByRole('heading', { name: 'Finance' });
      expect(
        screen.queryByRole('button', { name: /^edit$/i }),
      ).not.toBeInTheDocument();
      expect(await screen.findByText('Corporate LDAP')).toBeInTheDocument();
    });
  });

  describe('status', () => {
    it('says what deactivating the unit does to the people in it', async () => {
      mockApi();
      renderPage();

      await userEvent.click(
        await screen.findByRole('button', { name: /deactivate/i }),
      );
      expect(screen.getByText(/users stay where they are/i)).toBeInTheDocument();
    });

    it('offers no status control for a unit a directory owns', async () => {
      mockApi({ ...UNIT, sourceId: 's1' });
      renderPage();

      await screen.findByRole('heading', { name: 'Finance' });
      expect(
        screen.queryByRole('button', { name: /deactivate/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('deletion', () => {
    it('is not offered without directory.delete', async () => {
      mockApi();
      renderPage();

      await screen.findByRole('heading', { name: 'Finance' });
      expect(
        screen.queryByRole('button', { name: /^delete$/i }),
      ).not.toBeInTheDocument();
    });

    it('returns to the list once the unit is gone', async () => {
      granted.add('directory.delete');
      mockApi(UNIT, {
        '/api/admin/org-units/o1': (_url, init) =>
          init?.method === 'DELETE' ? json({}) : json(UNIT),
      });
      renderPage();

      await screen.findByRole('heading', { name: 'Finance' });
      await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
      await userEvent.type(screen.getByLabelText(/type finance/i), 'Finance');
      await userEvent.click(
        screen.getByRole('button', { name: /^delete org unit$/i }),
      );

      expect(await screen.findByText('the org units list')).toBeInTheDocument();
    });
  });

  it('shows the unit’s own log', async () => {
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByRole('heading', { name: 'Finance' });
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((c) => String(c[0]).includes('subject=o1')),
      ).toBe(true),
    );
  });

  it('reports a missing unit instead of rendering an empty one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) =>
      String(input).includes('/api/admin/org-units/o1')
        ? Promise.resolve(
            json(
              { title: 'Not found', detail: 'Org unit not found', status: 404 },
              404,
            ),
          )
        : Promise.resolve(json({ sources: [] }))) as typeof fetch);
    renderPage();

    expect(await screen.findByText(/org unit not found/i)).toBeInTheDocument();
  });

  it('offers a way back to the list', async () => {
    mockApi();
    renderPage();

    const back = await screen.findByRole('link', { name: /back to org units/i });
    expect(back).toHaveAttribute('href', '/admin/org-units');
  });

  describe('containers', () => {
    // The panel's own behaviour is covered in ContainersPanel.test.tsx. What
    // is checked here is the wiring: that the record carries it at all, and
    // that it is gated by the permission that governs materialisation rather
    // than by the one that governs reading a unit.
    const withContainers = () =>
      mockApi(UNIT, {
        '/containers': () => json({ containers: [] }),
        '/api/admin/targets': () => json({ targets: [] }),
      });

    it('carries the containers panel when the reader may materialise', async () => {
      granted.add('provision.manage');
      withContainers();
      renderPage();

      expect(await screen.findByText(/containers/i)).toBeInTheDocument();
    });

    it('withholds it from a reader who may not', async () => {
      withContainers();
      renderPage();

      // The record still renders -- the unit's name proves it -- and the
      // section is simply absent rather than present and refusing.
      expect(await screen.findByText('Finance')).toBeInTheDocument();
      expect(screen.queryByText(/containers/i)).not.toBeInTheDocument();
    });
  });
});
