import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeControlTab, type ChangeControlState, type ChangeRequest } from './ChangeControlTab.js';
import { HeldChangePrompt } from './HeldChangePrompt.js';
import { ChangeHeldError, api } from '../../session/api.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

const request = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id: 'cr-1', changeClass: 'admin_token', operation: 'api_token.issue', summary: 'Mint API token "ci" for svc (rbac.manage)',
  reason: 'CI needs to manage roles', status: 'pending', requestedByUserId: 'user-2', requestedAt: '2026-11-01T10:00:00Z',
  expiresAt: '2026-11-04T10:00:00Z', decidedByUserId: null, decidedAt: null, decisionNote: null, closedReason: null, ...over,
});

const state = (over: Partial<ChangeControlState> = {}): ChangeControlState => ({
  classes: ['admin_token'],
  catalog: [
    { key: 'role_grant', label: 'Privileged role grants', description: '', approverPermission: 'rbac.manage' },
    { key: 'admin_token', label: 'Admin-scoped API tokens', description: '', approverPermission: 'token.manage' },
  ],
  requests: [],
  viewerUserId: 'user-1',
  policy: { approvalWindowHours: 72, stepUpMaxAgeMinutes: 10, reasonMinLength: 10 },
  ...over,
});

function serve(routes: Record<string, (init?: RequestInit) => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (!match) throw new Error(`unexpected fetch ${url}`);
    return routes[match]!(init);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('ChangeControlTab', () => {
  it('offers the requester only withdrawal, and another administrator approval', async () => {
    serve({ '/api/admin/change-control': () => json(state({ requests: [request({ requestedByUserId: 'user-1' })] })) });
    const { unmount } = render(<ChangeControlTab />);
    expect(await screen.findByText('Needs another administrator')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
    unmount();
  });

  it('approves, and shows a minted secret once', async () => {
    const fetch = serve({
      '/api/admin/change-control': () => json(state({ requests: [request()] })),
      '/requests/cr-1/approve': () => json({ changeRequest: request({ status: 'applied' }), result: { id: 't-1', token: 'syntra_pat_secret' } }),
    });
    render(<ChangeControlTab />);
    await userEvent.type(await screen.findByLabelText('Note (optional)'), 'Checked with CI owner');
    await userEvent.click(screen.getByRole('button', { name: 'Approve and apply' }));
    expect(await screen.findByText('syntra_pat_secret')).toBeVisible();
    const sent = fetch.mock.calls.find(([url]) => String(url).endsWith('/approve'));
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ note: 'Checked with CI owner' });
  });

  it('shows the server refusal in its own words', async () => {
    serve({
      '/api/admin/change-control': () => json(state({ requests: [request()] })),
      '/requests/cr-1/approve': () => json({ type: 'https://syntra.dev/problems/stale', title: 'Change request refused', status: 409, detail: 'What this request changes has been modified since it was made' }, 409),
    });
    render(<ChangeControlTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve and apply' }));
    expect(await screen.findByText(/has been modified since it was made/)).toBeVisible();
  });

  it('warns that switching a class off is itself held', async () => {
    serve({ '/api/admin/change-control': () => json(state()) });
    render(<ChangeControlTab />);
    await userEvent.click(await screen.findByLabelText('Admin-scoped API tokens'));
    expect(screen.getByText(/itself held for a second administrator/)).toBeVisible();
  });
});

describe('held changes across the console', () => {
  it('asks for a reason, resends with it, and reports the change as held', async () => {
    const calls: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      calls.push(init ?? {});
      const headers = new Headers(init?.headers);
      if (!headers.has('x-syntra-change-reason')) {
        return json({ type: 'https://syntra.dev/problems/change-approval-required', title: 'A second administrator must approve this change', status: 409, detail: 'Held here.', summary: 'Grant role "Owner" to svc' }, 409);
      }
      return json({ status: 'pending_approval', changeRequest: { id: 'cr-9', summary: 'Grant role "Owner" to svc', changeClass: 'role_grant' } }, 202);
    });
    render(<HeldChangePrompt />);
    const pending = api('/api/admin/roles/r/assignments', { method: 'POST', body: '{}' }).catch((error: unknown) => error);
    const field = await screen.findByLabelText('Reason for the approver');
    await userEvent.type(field, 'New on-call administrator');
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(ChangeHeldError);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(new Headers(calls[1]!.headers).get('x-syntra-change-reason')).toBe(encodeURIComponent('New on-call administrator'));
  });

  it('sends nothing more when the reason is cancelled', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      json({ type: 'https://syntra.dev/problems/change-approval-required', title: 'Held', status: 409 }, 409));
    render(<HeldChangePrompt />);
    const pending = api('/api/admin/webhooks', { method: 'POST', body: '{}' }).catch((error: unknown) => error);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await pending).toMatchObject({ kind: 'change-approval-required' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
