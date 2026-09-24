import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PrivacyCasePage, type PrivacyCaseDetail } from './PrivacyCasePage.js';

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

const detail = (over: Partial<PrivacyCaseDetail['case']> = {}, rest: Partial<PrivacyCaseDetail> = {}): PrivacyCaseDetail => ({
  case: {
    id: 'case-1', reference: 'DSAR-2026-0001', personId: 'p-1', status: 'open', requestTypes: ['access', 'rectification', 'restriction', 'erasure'],
    reason: 'Letter ref PRIV-9', receivedAt: '2026-09-01T00:00:00Z', dueAt: '2026-10-01T00:00:00Z', verificationMethod: 'document',
    verificationAttestation: 'Passport sighted', openedByUserId: 'u-1', accessExportId: null, erasureStatus: null,
    erasureRequestedByUserId: null, erasureRequestedAt: null, erasureReceipt: null, closedAt: null, closureNote: null, ...over,
  },
  person: { id: 'p-1', name: 'Petra Privata', status: 'inactive', externalId: 'E-9', processingRestrictedAt: null, processingRestrictedCaseId: null, erasedAt: null },
  overdue: false,
  holdings: { Person: 1, Contract: 2, AuditEvent: 14 },
  erasureBlockers: [],
  timeline: [
    { id: 'e1', sequence: 1, occurredAt: '2026-09-01T10:00:00Z', actorUserId: 'u-1', action: 'privacy.case.open', outcome: 'success', payload: {} },
    { id: 'e2', sequence: 2, occurredAt: '2026-09-02T10:00:00Z', actorUserId: 'u-1', action: 'privacy.case.rectify', outcome: 'success', payload: { record: 'person', fields: ['familyName'] } },
  ],
  actors: { 'u-1': 'DPO One', 'u-2': 'DPO Two' },
  viewerUserId: 'u-2',
  policy: { erasureStepUpMaxAgeMinutes: 10 },
  ...rest,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/privacy/case-1']}>
      <Routes>
        <Route path="/admin/privacy/:id" element={<PrivacyCasePage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => { vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe('PrivacyCasePage', () => {
  it('shows the case, what the tenant holds, and the timeline from the audit log', async () => {
    serve({ '/api/admin/privacy/cases/case-1': () => json(detail()) });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'DSAR-2026-0001 · Petra Privata' })).toBeVisible();
    expect(screen.getByText('AuditEvent')).toBeVisible();
    expect(screen.getByText('Record rectified')).toBeVisible();
    expect(screen.getByText('person: familyName')).toBeVisible();
    expect(screen.getAllByText('DPO One').length).toBeGreaterThan(0);
  });

  it('rectifies through the ordinary person edit, naming the case', async () => {
    const fetch = serve({
      '/api/admin/privacy/cases/case-1': () => json(detail()),
      '/api/admin/persons/p-1': () => json({ id: 'p-1' }),
    });
    renderPage();
    await userEvent.type(await screen.findByLabelText('Family name'), 'Privata-Correct');
    await userEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(await screen.findByText('Rectified: familyName.')).toBeVisible();
    const sent = fetch.mock.calls.find(([url]) => String(url).endsWith('/api/admin/persons/p-1'));
    expect(sent?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ familyName: 'Privata-Correct', privacyCaseId: 'case-1' });
  });

  it('keeps erasure closed while blockers apply, and names them', async () => {
    serve({
      '/api/admin/privacy/cases/case-1': () => json(detail({}, {
        erasureBlockers: [{ code: 'legal-hold-active', count: 1, message: '1 active legal hold(s) cover this person (LIT-42); they must be released first.' }],
      })),
    });
    renderPage();
    expect(await screen.findByText(/LIT-42/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Request erasure' })).toBeDisabled();
  });

  it('does not offer approval to the requester', async () => {
    serve({
      '/api/admin/privacy/cases/case-1': () => json(detail({ erasureStatus: 'pending_approval', erasureRequestedByUserId: 'u-2', erasureRequestedAt: '2026-09-03T00:00:00Z' })),
    });
    renderPage();
    expect(await screen.findByText('A different administrator must approve.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve erasure' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel erasure' })).toBeEnabled();
  });

  it('lets a second administrator approve after typing ERASE, and shows a refusal in the server\'s words', async () => {
    let approvals = 0;
    const fetch = serve({
      '/api/admin/privacy/cases/case-1': () => json(detail({ erasureStatus: 'pending_approval', erasureRequestedByUserId: 'u-1', erasureRequestedAt: '2026-09-03T00:00:00Z' })),
      '/erasure/approve': () => {
        approvals += 1;
        return approvals === 1
          ? json({ type: 'privacy-step-up-required', title: 'Privacy case refused', status: 403, detail: 'Sign in to the console again to approve an erasure' }, 403)
          : json({ case: {}, receipt: { digest: 'd'.repeat(64) } });
      },
    });
    renderPage();
    const approve = await screen.findByRole('button', { name: 'Approve erasure' });
    expect(approve).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type ERASE to approve'), 'ERASE');
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    expect(await screen.findByText('Sign in to the console again to approve an erasure')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Approve erasure' }));
    expect(await screen.findByText(/Erasure completed/)).toBeVisible();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/erasure/approve'))).toHaveLength(2);
  });

  it('restricts processing', async () => {
    const fetch = serve({
      '/api/admin/privacy/cases/case-1': () => json(detail()),
      '/restriction': () => json({ case: {} }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Restrict processing' }));
    expect(await screen.findByText(/Processing restricted/)).toBeVisible();
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/restriction') && init?.method === 'POST')).toBe(true);
  });
});
