import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AttentionBanner } from './AttentionBanner.js';
import { IncidentsTab } from './IncidentsTab.js';
import { thresholdHints } from './threshold-hints.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const runItem = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  targetSystemId: 'target-1',
  targetName: 'ssander.xyz entra',
  status: 'blocked',
  requiresConfirmation: true,
  blockedReason: 'would create 1 of 2 accounts (50.0%), above the 20% threshold',
  plannedChanges: 1,
  planned: 'would create 1 account',
  summary: 'Held for confirmation: would create 1 of 2 accounts (50.0%), above the 20% threshold',
  startedAt: '2026-09-24T12:00:00.000Z',
  href: '/admin/targets/target-1/runs/run-1',
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  total: 2,
  provisionRuns: { count: 1, items: [runItem()] },
  lifecycle: { failed: 0, awaitingVerification: 1, items: [] },
  changeRequests: null,
  ...over,
});

function mockApi(attention: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const path = String(input);
    if (path.includes('/attention/summary')) return Promise.resolve(json(attention));
    return Promise.resolve(json({ incidents: [] }));
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('AttentionBanner', () => {
  it('names the held run, what it would do, and links to it and to Attention', async () => {
    mockApi(summary());
    render(<MemoryRouter><AttentionBanner /></MemoryRouter>);
    const banner = await screen.findByRole('status', { name: 'Work that needs your attention' });
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(within(banner).getByText('2 items need your attention')).toBeInTheDocument();
    expect(banner).toHaveTextContent('A provisioning run on ssander.xyz entra is held for review — would create 1 of 2 accounts (50.0%), above the 20% threshold');
    expect(banner).toHaveTextContent('1 lifecycle operation is waiting for the target account to be verified');
    expect(within(banner).getByRole('link', { name: 'Review the run' })).toHaveAttribute('href', '/admin/targets/target-1/runs/run-1');
    expect(within(banner).getByRole('link', { name: /Activity → Attention/ })).toHaveAttribute('href', '/admin/activity?tab=attention');
  });

  it('shows nothing when nothing is waiting', async () => {
    const fetchMock = mockApi(summary({ total: 0, provisionRuns: { count: 0, items: [] }, lifecycle: { failed: 0, awaitingVerification: 0, items: [] } }));
    render(<MemoryRouter><AttentionBanner /></MemoryRouter>);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('status', { name: 'Work that needs your attention' })).toBeNull();
  });

  it('dismisses for the session, and comes back when something new arrives', async () => {
    mockApi(summary());
    const first = render(<MemoryRouter><AttentionBanner /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss for this session' }));
    expect(screen.queryByRole('status', { name: 'Work that needs your attention' })).toBeNull();
    first.unmount();

    // Same items on the next page: still dismissed.
    const again = render(<MemoryRouter><AttentionBanner /></MemoryRouter>);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('status', { name: 'Work that needs your attention' })).toBeNull();
    again.unmount();

    // A second held run is news.
    vi.restoreAllMocks();
    mockApi(summary({ total: 3, provisionRuns: { count: 2, items: [runItem(), runItem({ runId: 'run-2', targetName: 'AD' })] } }));
    render(<MemoryRouter><AttentionBanner /></MemoryRouter>);
    expect(await screen.findByRole('status', { name: 'Work that needs your attention' })).toHaveTextContent('3 items need your attention');
  });
});

describe('Activity → Attention', () => {
  it('lists runs waiting for review beside the incidents', async () => {
    mockApi(summary());
    render(<MemoryRouter><IncidentsTab /></MemoryRouter>);
    expect(await screen.findByText('Waiting for a decision')).toBeInTheDocument();
    expect(screen.getByText(/A provisioning run on ssander.xyz entra is held for review/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review the run' })).toHaveAttribute('href', '/admin/targets/target-1/runs/run-1');
    expect(await screen.findByText(/nothing is broken/i)).toBeInTheDocument();
  });
});

describe('thresholdHints', () => {
  it('maps each tripped reason to its setting', () => {
    const hints = thresholdHints(
      'would create 1 of 2 accounts (50.0%), above the 20% threshold; would revoke "Finance" from 3 of 4 holders (75.0%), above the 10% per-entitlement threshold; would move 5 of 10 accounts to a different container (50.0%), above the 10% threshold',
    );
    expect(hints.map((hint) => hint.key)).toEqual([
      'createAccountThresholdPercent',
      'perEntitlementThresholdPercent',
      'archiveAccountThresholdPercent',
    ]);
    expect(hints[0]).toMatchObject({ label: 'Accounts created', share: 50, threshold: 20 });
    expect(hints[2]!.note).toMatch(/archive threshold/);
  });

  it('names nothing for reasons that are not a threshold', () => {
    expect(thresholdHints('the target returned no accounts at all')).toEqual([]);
    expect(thresholdHints(null)).toEqual([]);
  });
});
