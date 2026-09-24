import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BreakGlassTab, type BreakGlassActivation, type BreakGlassState } from './BreakGlassTab.js';
import { BreakGlassBanner } from './BreakGlassBanner.js';
import { BreakGlass } from '../BreakGlass.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

const activation = (over: Partial<BreakGlassActivation> = {}): BreakGlassActivation => ({
  id: 'act-1', userId: 'glass', login: 'glass', displayName: 'Emergency', status: 'pending',
  reason: 'All security keys lost in the fire', durationMinutes: 60, requestedAt: '2026-11-01T10:00:00Z',
  requestedFromIp: '203.0.113.5', activatesAt: '2026-11-01T11:00:00Z', activatedAt: null, activatedBy: null,
  expiresAt: null, endedAt: null, reviewStatus: 'not_due', reviewedByUserId: null, reviewNotes: null, ...over,
});

const state = (over: Partial<BreakGlassState> = {}): BreakGlassState => ({
  activationDelayMinutes: 60,
  accounts: [{ userId: 'glass', login: 'glass', displayName: 'Emergency', status: 'active', designatedAt: '2026-10-01T00:00:00Z', credentialIssuedAt: '2026-10-01T00:00:00Z' }],
  activations: [],
  viewerUserId: 'admin',
  policy: { delayBounds: { min: 15, max: 1440 }, durationBounds: { min: 15, max: 240 }, reviewMinLength: 20, stepUpMaxAgeMinutes: 10 },
  ...over,
});

function serve(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (!match) throw new Error(`unexpected fetch ${url}`);
    return routes[match]!();
  });
}

afterEach(() => vi.restoreAllMocks());

describe('BreakGlassTab', () => {
  it('designates an account and shows the sealed credential once', async () => {
    serve({
      '/api/admin/break-glass': () => json(state({ accounts: [] })),
      '/api/admin/users?pageSize=200': () => json({ users: [{ id: 'glass', login: 'glass', displayName: 'Emergency' }, { id: 'admin', login: 'admin', displayName: 'Me' }] }),
      '/api/admin/break-glass/accounts': () => json({ userId: 'glass', credential: 'syntra_bg_sealed' }, 201),
    });
    render(<BreakGlassTab />);
    const select = await screen.findByLabelText('Designate an account');
    // Never yourself.
    expect(screen.queryByRole('option', { name: 'Me (admin)' })).toBeNull();
    await userEvent.selectOptions(select, 'glass');
    await userEvent.click(screen.getByRole('button', { name: 'Designate' }));
    expect(await screen.findByText('syntra_bg_sealed')).toBeVisible();
  });

  it('offers early approval only to somebody other than the emergency account', async () => {
    serve({
      '/api/admin/break-glass': () => json(state({ viewerUserId: 'glass', activations: [activation()] })),
      '/api/admin/users?pageSize=200': () => json({ users: [] }),
    });
    render(<BreakGlassTab />);
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Approve now' })).toBeNull();
  });

  it('holds the review until the findings are substantive', async () => {
    const fetch = serve({
      '/api/admin/break-glass': () => json(state({ activations: [activation({ status: 'ended', reviewStatus: 'pending', activatedAt: '2026-11-01T11:00:00Z', endedAt: '2026-11-01T11:30:00Z' })] })),
      '/api/admin/users?pageSize=200': () => json({ users: [] }),
      '/activations/act-1/review': () => json({ activation: activation({ status: 'ended', reviewStatus: 'completed' }) }),
    });
    render(<BreakGlassTab />);
    const complete = await screen.findByRole('button', { name: 'Complete review' });
    await userEvent.type(screen.getByLabelText('Review findings'), 'fine');
    expect(complete).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Review findings'), ' — keys re-registered for two admins');
    await userEvent.click(complete);
    expect(await screen.findByText('Review recorded.')).toBeVisible();
    const sent = fetch.mock.calls.find(([url]) => String(url).endsWith('/review'));
    expect(JSON.parse(String(sent?.[1]?.body)).notes).toContain('keys re-registered');
  });
});

describe('BreakGlassBanner', () => {
  it('shows every administrator an active activation and outstanding reviews', async () => {
    serve({
      '/api/admin/break-glass/status': () => json({
        activations: [{ id: 'act-1', userId: 'glass', displayName: 'Emergency', status: 'active', reason: 'Keys lost in the fire', activatesAt: '2026-11-01T11:00:00Z', expiresAt: '2026-11-01T12:00:00Z' }],
        reviewsDue: 1,
        viewerActivationId: null,
      }),
    });
    render(<MemoryRouter><BreakGlassBanner /></MemoryRouter>);
    expect(await screen.findByText(/Emergency access is active for Emergency/)).toBeVisible();
    expect(screen.getByText(/1 emergency access review outstanding/)).toBeVisible();
  });

  it('renders nothing when all is quiet', async () => {
    const fetch = serve({ '/api/admin/break-glass/status': () => json({ activations: [], reviewsDue: 0, viewerActivationId: null }) });
    const { container } = render(<MemoryRouter><BreakGlassBanner /></MemoryRouter>);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('BreakGlass request page', () => {
  it('requests activation and says when it takes effect', async () => {
    const fetch = serve({
      '/api/auth/break-glass/activate': () => json({ status: 'pending', activationId: 'act-1', activatesAt: '2026-11-01T11:00:00Z', durationMinutes: 60 }, 202),
    });
    render(<MemoryRouter><BreakGlass /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Emergency account login'), 'glass');
    await userEvent.type(screen.getByLabelText('Sealed credential'), 'syntra_bg_sealed');
    await userEvent.type(screen.getByLabelText('Reason'), 'All security keys lost in the fire');
    await userEvent.click(screen.getByRole('button', { name: 'Request emergency access' }));
    expect(await screen.findByText(/Every administrator has been told/)).toBeVisible();
    const sent = fetch.mock.calls[0]!;
    expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ login: 'glass', credential: 'syntra_bg_sealed', durationMinutes: 60 });
  });
});
