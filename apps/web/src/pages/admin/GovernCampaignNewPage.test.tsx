import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GovernCampaignNewPage } from './GovernCampaignNewPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const snapshots = [{ id: 's-1', asOf: '2026-08-20T02:00:00.000Z', status: 'complete' }];

function mockApi(over: { create?: Response } = {}) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/preview-scope')) {
        return Promise.resolve(
          json({
            holdings: 4120,
            persons: 1180,
            systems: 6,
            sample: [{ subjectKey: 'person:p1', resourceName: 'Domain Admins' }],
          }),
        );
      }
      if (url.endsWith('/preview-reviewers')) {
        return Promise.resolve(
          json({
            resolved: 1102,
            viaFallback: 61,
            blocked: 17,
            blockedSample: [
              { subjectKey: 'person:p9', resourceName: 'Ledger', reason: 'no manager' },
            ],
          }),
        );
      }
      return Promise.resolve(over.create ?? json({ id: 'c-1' }, 201));
    }
    if (url.includes('/govern/snapshots')) return Promise.resolve(json({ snapshots }));
    if (url.includes('/persons')) return Promise.resolve(json({ persons: [] }));
    return Promise.resolve(json({}));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <GovernCampaignNewPage />
    </MemoryRouter>,
  );

const fillTheEssentials = async () => {
  await userEvent.type(screen.getByLabelText('Name'), 'H2 access review');
  await userEvent.click(screen.getByRole('checkbox', { name: /targetEntitlement/ }));
  await userEvent.type(
    screen.getByLabelText('Owner person id'),
    '33333333-3333-4333-8333-333333333333',
  );
  await userEvent.type(screen.getByLabelText('Opens'), '2026-09-01');
  await userEvent.type(screen.getByLabelText('Due'), '2026-09-30');
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('creating a campaign', () => {
  /**
   * The whole access-review module was inert from the console: create, start,
   * re-base and both previews existed on the server, had routes, and had no
   * way in -- while the campaigns page's empty state told the reader to create
   * one.
   */
  it('sends everything createCampaignBody requires', async () => {
    const sent = mockApi();
    renderPage();
    await screen.findByLabelText('Name');
    await fillTheEssentials();

    await userEvent.click(screen.getByRole('button', { name: 'Create the campaign' }));

    await waitFor(() =>
      expect(sent.filter((s) => s.url.endsWith('/campaigns'))).toHaveLength(1),
    );
    expect(sent.at(-1)!.body).toMatchObject({
      name: 'H2 access review',
      scope: { resourceKinds: ['targetEntitlement'] },
      reviewerSelector: 'manager',
      fallbackSelector: 'productOwner',
      ownerPersonId: '33333333-3333-4333-8333-333333333333',
      allowBulkCertify: false,
    });
  });

  /**
   * Section 20 in words: "this scope covers 4,120 holdings across 1,180
   * persons and 6 systems". The screen that catches an unreviewable campaign
   * before 200 people are emailed, rather than at 3am on the due date -- and
   * it existed on the server with nothing calling it.
   */
  it('shows the scope preview before anything is created', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('checkbox', { name: /targetEntitlement/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Show me what this covers' }));
    expect(await screen.findByText(/4,?120 holdings/)).toBeInTheDocument();
    expect(screen.getByText(/1,?180 persons/)).toBeInTheDocument();
  });

  /**
   * And the reviewer preview NAMES the items that resolve to nobody. A count
   * of 17 unreviewable items is not actionable; the sample is what makes it
   * one.
   */
  it('names the items that would resolve to nobody', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('checkbox', { name: /targetEntitlement/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Show me who would review it' }));
    expect(await screen.findByText(/17 resolve to nobody/)).toBeInTheDocument();
    expect(screen.getByText(/no manager/)).toBeInTheDocument();
  });

  /**
   * A scope with no resource kinds covers NOTHING -- `campaignScopeInput` says
   * `.min(1)` for exactly that reason -- so the form must not let one be sent.
   */
  it('will not create a campaign whose scope covers nothing', async () => {
    const sent = mockApi();
    renderPage();
    await screen.findByLabelText('Name');
    await userEvent.type(screen.getByLabelText('Name'), 'Empty');

    expect(screen.getByRole('button', { name: 'Create the campaign' })).toBeDisabled();
    expect(sent.filter((s) => s.url.endsWith('/campaigns'))).toHaveLength(0);
  });

  it('renders the server refusal rather than a generic apology', async () => {
    mockApi({
      create: json(
        {
          type: 'https://syntra.dev/problems/stale_snapshot',
          title: 'Campaign refused',
          status: 409,
          detail: 'the snapshot is older than maxSnapshotAgeDays',
        },
        409,
      ),
    });
    renderPage();
    await screen.findByLabelText('Name');
    await fillTheEssentials();
    await userEvent.click(screen.getByRole('button', { name: 'Create the campaign' }));

    expect(
      await screen.findByText('the snapshot is older than maxSnapshotAgeDays'),
    ).toBeInTheDocument();
  });
});
