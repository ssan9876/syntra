import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@syntra/ui';
import { ApplicationDetailPage } from './ApplicationDetailPage.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const problem = (status: number, type: string, detail: string) =>
  json({ type: `https://syntra.dev/problems/${type}`, title: type, status, detail }, status);

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

/**
 * The page's reads, and one answer for whatever it writes. Every write is
 * recorded so a test can say what was sent, not only what was shown.
 */
function mockApi(write: (call: Sent) => Response) {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      sent.push(call);
      return Promise.resolve(write(call));
    }
    if (url.includes('/assignments')) {
      return Promise.resolve(
        json({
          assignments: [
            { id: 'a1', subjectType: 'group', userId: null, groupId: 'g1', orgUnitId: null },
            { id: 'a2', subjectType: 'group', userId: null, groupId: 'g2', orgUnitId: null },
          ],
        }),
      );
    }
    if (url.includes('/groups')) return Promise.resolve(json({ groups: [], total: 0 }));
    if (url.includes('/users')) return Promise.resolve(json({ users: [], total: 0 }));
    if (url.includes('/org-units')) return Promise.resolve(json({ orgUnits: [] }));
    if (url.endsWith('/api/admin/applications')) {
      return Promise.resolve(
        json({
          applications: [{ id: 'app-1', name: 'Ledger', slug: 'ledger', status: 'active', type: 'saml', icon: null }],
        }),
      );
    }
    // The SSO panel's reads: nothing configured.
    return Promise.resolve(problem(404, 'not-found', 'Not configured'));
  });
  return sent;
}

const renderPage = () =>
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/admin/applications/app-1']}>
        <Routes>
          <Route path="/admin/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/admin/applications" element={<p>Applications list</p>} />
          <Route path="/elevate" element={<p>Elevate page</p>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );

async function openDialog() {
  await userEvent.click(await screen.findByRole('button', { name: 'Delete application' }));
  return screen.getByRole('dialog', { name: 'Delete Ledger?' });
}

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
  granted.add('access.read');
  granted.add('access.manage');
});
afterEach(() => vi.unstubAllGlobals());

describe('the danger zone', () => {
  it('is not offered to somebody who cannot manage access', async () => {
    granted.delete('access.manage');
    mockApi(() => json({}));
    renderPage();
    await screen.findByText('Assigned to');
    expect(screen.queryByText('Danger zone')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete application' })).not.toBeInTheDocument();
  });

  it('explains what goes, and deletes only once the name is typed exactly', async () => {
    const sent = mockApi(() => json({ deleted: { id: 'app-1', name: 'Ledger', assignments: 2 } }));
    renderPage();
    // Wait for the assignments, so the dialog can count who loses access.
    await screen.findByText('Assigned to');
    const dialog = await openDialog();

    expect(within(dialog).getByText(/stop immediately for 2 assignments/)).toBeInTheDocument();
    expect(within(dialog).getByText(/client secret/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Cannot be undone/)).toBeInTheDocument();

    const confirm = within(dialog).getByRole('button', { name: 'Delete application' });
    expect(confirm).toBeDisabled();
    const field = within(dialog).getByLabelText('Type Ledger to confirm');
    await userEvent.type(field, 'ledger');
    // Case matters: the server compares exactly, and so does the button.
    expect(confirm).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, 'Ledger');
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);

    expect(await screen.findByText('Applications list')).toBeInTheDocument();
    expect(await screen.findByText('Ledger deleted')).toBeInTheDocument();
    expect(sent).toEqual([
      { method: 'DELETE', url: '/api/admin/applications/app-1', body: { confirm: 'Ledger' } },
    ]);
  });

  it('sends nothing when cancelled, and forgets what was typed', async () => {
    const sent = mockApi(() => json({}));
    renderPage();
    let dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText('Type Ledger to confirm'), 'Ledger');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    dialog = await openDialog();
    expect(within(dialog).getByLabelText('Type Ledger to confirm')).toHaveValue('');
    expect(sent).toEqual([]);
  });

  it('keeps the dialog open with the server\'s reason when the delete is refused', async () => {
    mockApi(() =>
      problem(
        409,
        'application-in-use',
        'Not deleted: catalog products grant it ("Ledger access"). Remove it from those products and end those grants first, or retire the application instead.',
      ),
    );
    renderPage();
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText('Type Ledger to confirm'), 'Ledger');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete application' }));

    expect(await within(dialog).findByText(/catalog products grant it/)).toBeInTheDocument();
    expect(screen.queryByText('Applications list')).not.toBeInTheDocument();
  });

  it('offers to elevate when the session is too old, and goes there', async () => {
    mockApi(() =>
      problem(403, 'step-up-required', 'Deleting an application needs a console session started in the last 10 minutes.'),
    );
    renderPage();
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText('Type Ledger to confirm'), 'Ledger');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete application' }));

    expect(await screen.findByText(/needs a console session started/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm it is you' }));
    expect(await screen.findByText('Elevate page')).toBeInTheDocument();
  });

  it('retires the application as the reversible option', async () => {
    const sent = mockApi(() => json({ id: 'app-1', status: 'inactive' }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Retire' }));

    await waitFor(() =>
      expect(sent).toEqual([
        { method: 'PUT', url: '/api/admin/applications/app-1', body: { status: 'inactive' } },
      ]),
    );
    expect(await screen.findByText('Ledger retired')).toBeInTheDocument();
  });
});
