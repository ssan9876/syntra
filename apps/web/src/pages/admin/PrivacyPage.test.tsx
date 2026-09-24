import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PrivacyPage, type PrivacyCaseSummary } from './PrivacyPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

function serve(routes: Record<string, (init?: RequestInit) => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (!match) throw new Error(`unexpected fetch ${url}`);
    return routes[match]!(init);
  });
}

const row = (over: Partial<PrivacyCaseSummary> = {}): PrivacyCaseSummary => ({
  id: 'case-1', reference: 'DSAR-2026-0001', personId: 'p-1', personName: 'Petra Privata', status: 'open',
  requestTypes: ['access', 'erasure'], receivedAt: '2026-09-01T00:00:00Z', dueAt: '2026-10-01T00:00:00Z',
  overdue: false, erasureStatus: null, ...over,
});

const renderPage = (entry = '/admin/privacy') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/privacy" element={<PrivacyPage />} />
        <Route path="/admin/privacy/:id" element={<p>case page</p>} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => vi.restoreAllMocks());

describe('PrivacyPage', () => {
  it('lists open cases with what was asked for, and marks one overdue', async () => {
    serve({ '/api/admin/privacy/cases?status=open': () => json({ cases: [row(), row({ id: 'case-2', reference: 'DSAR-2026-0002', overdue: true, erasureStatus: 'pending_approval' })] }) });
    renderPage();
    expect(await screen.findByRole('link', { name: 'DSAR-2026-0001' })).toHaveAttribute('href', '/admin/privacy/case-1');
    expect(screen.getAllByText('Access, Erasure')).toHaveLength(2);
    expect(screen.getByText('overdue')).toBeVisible();
    expect(screen.getByText('erasure awaiting approval')).toBeVisible();
  });

  it('opens a case only with a subject, a reason and a verification attestation', async () => {
    const fetch = serve({
      '/api/admin/privacy/cases?status=open': () => json({ cases: [] }),
      '/api/admin/persons?q=petra&pageSize=10': () => json({ persons: [{ id: 'p-1', givenName: 'Petra', familyName: 'Privata', externalId: 'E-9', status: 'inactive' }] }),
      '/api/admin/privacy/cases': () => json({ case: { id: 'case-9' } }, 201),
    });
    renderPage();
    expect(await screen.findByText('No cases')).toBeVisible();
    const open = screen.getByRole('button', { name: 'Open case' });
    expect(open).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Find the person'), 'petra');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(await screen.findByRole('button', { name: /Petra Privata/ }));
    await userEvent.click(screen.getByLabelText('Erasure'));
    await userEvent.type(screen.getByLabelText('Request and how it arrived'), 'Letter ref PRIV-9');
    expect(open).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Verification attestation'), 'Passport sighted by the DPO');
    await waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);

    expect(await screen.findByText('case page')).toBeVisible();
    const sent = fetch.mock.calls.find(([url, init]) => String(url).endsWith('/api/admin/privacy/cases') && init?.method === 'POST');
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
      personId: 'p-1', requestTypes: ['access', 'erasure'], reason: 'Letter ref PRIV-9', verificationMethod: 'document',
      verificationAttestation: 'Passport sighted by the DPO', dueInDays: 30,
    });
  });

  it('starts from the person a link names', async () => {
    serve({ '/api/admin/privacy/cases?status=open': () => json({ cases: [] }) });
    renderPage('/admin/privacy?person=p-7');
    expect(await screen.findByRole('button', { name: 'Change' })).toBeVisible();
    expect(screen.queryByLabelText('Find the person')).toBeNull();
  });
});
