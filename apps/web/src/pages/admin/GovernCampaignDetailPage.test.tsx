import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GovernCampaignDetailPage } from './GovernCampaignDetailPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const snapshots = [{ id: 's-1', asOf: '2026-08-20T02:00:00.000Z', status: 'complete' }];

const detail = (status: string) => ({
  campaign: {
    id: 'c-1',
    name: 'H2 access review',
    status,
    dueAt: '2026-09-30T00:00:00.000Z',
    originalDueAt: '2026-09-30T00:00:00.000Z',
    snapshotId: 's-1',
  },
  counts: {
    total: 0,
    certified: 0,
    revoked: 0,
    requiresChange: 0,
    moot: 0,
    undecided: 0,
    blocked: 0,
  },
  coverage: { percent: 100, denominator: 0, statement: 'every system was read in full' },
  signals: [],
});

function mockApi(opts: { status?: string; start?: Response } = {}) {
  const sent: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      sent.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/start')) {
        return Promise.resolve(opts.start ?? json({ itemCount: 12, blockedCount: 0 }));
      }
      if (url.endsWith('/rebase')) return Promise.resolve(json({ reopened: 3, kept: 9 }));
      return Promise.resolve(json({}));
    }
    if (url.includes('/govern/snapshots')) return Promise.resolve(json({ snapshots }));
    return Promise.resolve(json(detail(opts.status ?? 'draft')));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/govern/campaigns/c-1']}>
      <Routes>
        <Route path="/admin/govern/campaigns/:id" element={<GovernCampaignDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('starting a campaign', () => {
  /**
   * A campaign is created as a DRAFT and generates nothing until it is
   * started. `startCampaign` writes the items, resolves the reviewers and
   * sends the mail -- and had no way in, so every campaign the API could
   * create sat as a draft forever.
   */
  it('offers Start on a draft and reports what it generated', async () => {
    const sent = mockApi({ status: 'draft' });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Start it' }));

    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/c-1/start'))).toBe(true));
    expect(await screen.findByText(/12 item\(s\) generated/)).toBeInTheDocument();
  });

  /**
   * The blocked count is SAID, because an item that resolves to nobody cannot
   * be decided by anybody and the person who started the campaign is the one
   * who can still fix it.
   */
  it('says how many resolved to nobody', async () => {
    mockApi({ status: 'draft', start: json({ itemCount: 12, blockedCount: 4 }) });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Start it' }));
    expect(await screen.findByText(/4 resolved to nobody/)).toBeInTheDocument();
  });

  it('does not offer it once the campaign has closed', async () => {
    mockApi({ status: 'closed_complete' });
    renderPage();
    await screen.findByRole('button', { name: 'Re-base' });
    expect(screen.queryByRole('button', { name: 'Start it' })).toBeNull();
  });

  /** `CampaignRefusedError` carries a real sentence; it has to reach the page. */
  it('renders the server refusal when starting is refused', async () => {
    mockApi({
      status: 'draft',
      start: json(
        {
          type: 'https://syntra.dev/problems/empty_scope',
          title: 'Campaign refused',
          status: 409,
          detail: 'this scope covers no holdings',
        },
        409,
      ),
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Start it' }));
    expect(await screen.findByText('this scope covers no holdings')).toBeInTheDocument();
  });
});

describe('re-basing a campaign', () => {
  /**
   * Section 8 rule 2: a campaign whose snapshot aged past `maxSnapshotAgeDays`
   * must be re-based before its revocations can execute. The endpoint existed
   * and nothing could call it, so a campaign that aged out was permanently
   * unexecutable.
   */
  it('is disabled until a snapshot is chosen, then sends it', async () => {
    const sent = mockApi({ status: 'open' });
    renderPage();

    const rebase = await screen.findByRole('button', { name: 'Re-base' });
    expect(rebase).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Re-base onto'), 's-1');
    await userEvent.click(screen.getByRole('button', { name: 'Re-base' }));

    await waitFor(() => {
      const call = sent.find((s) => s.url.endsWith('/c-1/rebase'));
      expect(call?.body).toEqual({ snapshotId: 's-1' });
    });
    expect(await screen.findByText(/3 item\(s\) re-opened, 9 kept/)).toBeInTheDocument();
  });
});
