import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TenantDeletionTab, type DeletionRequest, type DeletionState } from './TenantDeletionTab.js';

const policy = { approvalWindowHours: 72, coolingOffHours: 24, executionWindowHours: 168, stepUpMaxAgeMinutes: 15, reasonMinLength: 20 };
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

const request = (over: Partial<DeletionRequest> = {}): DeletionRequest => ({
  id: 'req-1', status: 'pending_approval', assessmentDigest: A, exportDigest: B, reason: 'Contract ended; offboarding form signed',
  requestedByUserId: 'user-1', requestedAt: '2026-09-23T10:00:00Z', approvalExpiresAt: '2026-09-26T10:00:00Z',
  approvedByUserId: null, approvedAt: null, executeNotBefore: null, executeBefore: null, cancelledAt: null, closedReason: null, ...over,
});

/** Routes fetches by URL, recording each call. */
function serve(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (!match) throw new Error(`unexpected fetch ${url}`);
    return routes[match]!();
  });
}

const state = (over: Partial<DeletionState> = {}): DeletionState => ({ request: null, viewerUserId: 'user-1', policy, ...over });

// jsdom cannot follow the download link; the file itself is the browser's job.
beforeEach(() => { vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe('TenantDeletionTab', () => {
  it('offers a request only after an assessment, an export, and a substantive reason', async () => {
    const fetch = serve({
      '/api/admin/tenant/deletion': () => json(state()),
      '/offboarding/assess': () => json({ deletionReady: true, digest: A, blockers: { activeLegalHolds: 0, unresolvedLifecycleOperations: 0 }, inventory: {} }),
      '/offboarding/export': () => json({ digest: B, tenant: { id: 't-1' } }),
      '/deletion/requests': () => json(request()),
    });
    render(<TenantDeletionTab />);
    const submit = await screen.findByRole('button', { name: 'Request deletion' });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Assess tenant' }));
    await screen.findByText('ready');
    await userEvent.click(screen.getByRole('button', { name: 'Download export' }));
    await userEvent.type(screen.getByLabelText('Reason for deleting this tenant'), 'too short');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason for deleting this tenant'), ' - contract ended in full');
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);

    await screen.findByText(/different administrator must approve it/);
    const sent = fetch.mock.calls.find(([url]) => String(url).endsWith('/deletion/requests'));
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ assessmentDigest: A, exportDigest: B, reason: 'too short - contract ended in full' });
  });

  it('keeps the request action closed while the assessment reports a blocker', async () => {
    serve({
      '/api/admin/tenant/deletion': () => json(state()),
      '/offboarding/assess': () => json({ deletionReady: false, digest: A, blockers: { activeLegalHolds: 1, unresolvedLifecycleOperations: 0 }, inventory: {} }),
    });
    render(<TenantDeletionTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assess tenant' }));
    expect(await screen.findByText('blocked')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Request deletion' })).toBeDisabled();
  });

  it('does not offer approval to the administrator who requested it', async () => {
    serve({ '/api/admin/tenant/deletion': () => json(state({ request: request() })) });
    render(<TenantDeletionTab />);
    expect(await screen.findByText(/different administrator must approve, within 72 hours/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve deletion' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeEnabled();
  });

  it('lets a second administrator approve, and shows the server refusal in its own words', async () => {
    serve({
      '/api/admin/tenant/deletion': () => json(state({ request: request(), viewerUserId: 'user-2' })),
      '/req-1/approve': () => json({ type: 'https://syntra.dev/problems/step-up-required', title: 'Tenant deletion refused', status: 403, detail: 'Sign in to the console again to confirm this deletion step' }, 403),
    });
    render(<TenantDeletionTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve deletion' }));
    expect(await screen.findByText('Sign in to the console again to confirm this deletion step')).toBeVisible();
  });

  it('holds execution through the cooling-off period and then requires typed confirmation', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const approved = request({ status: 'approved', approvedByUserId: 'user-2', approvedAt: new Date().toISOString(), executeNotBefore: future, executeBefore: later });
    serve({ '/api/admin/tenant/deletion': () => json(state({ request: approved })) });
    const { unmount } = render(<TenantDeletionTab />);
    expect(await screen.findByText(/Cooling off until/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete tenant now' })).toBeDisabled();
    unmount();
    vi.restoreAllMocks();

    const ready = { ...approved, executeNotBefore: new Date(Date.now() - 1000).toISOString() };
    serve({
      '/api/admin/tenant/deletion': () => json(state({ request: ready })),
      '/req-1/execute': () => json({ schema: 'syntra.tenant-deletion-receipt.v1', tenantId: 't-1' }),
    });
    render(<TenantDeletionTab />);
    const execute = await screen.findByRole('button', { name: 'Delete tenant now' });
    expect(execute).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await userEvent.click(execute);
    expect(await screen.findByText('The tenant has been erased')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download receipt' })).toBeVisible();
  });
});
