import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GovernReportsPage } from './GovernReportsPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const snapshots = [
  { id: 's-new', asOf: '2026-08-20T02:00:00.000Z', status: 'complete' },
  { id: 's-old', asOf: '2026-07-20T02:00:00.000Z', status: 'complete' },
];

const report = {
  header: {
    live: false,
    snapshotId: 's-new',
    asOf: '2026-08-20T02:00:00.000Z',
    sources: [],
    coverageGapCount: 0,
    unattributableCount: 0,
    unattributedAccountCount: 0,
    scopeDescription: 'the whole tenant',
  },
  body: { rows: [], holderCount: { known: true, value: 0 } },
};

function mockApi() {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/govern/snapshots')) return Promise.resolve(json({ snapshots }));
    if (url.includes('/govern/reports/system')) return Promise.resolve(json(report));
    return Promise.resolve(json({}));
  });
  return urls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <GovernReportsPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the reports screen', () => {
  /**
   * The "Live" toggle was wired to nothing: mode state was kept and a caveat
   * rendered, and the URL was always the snapshot one. An administrator read a
   * snapshot believing it was live, and there was no producer of
   * `LiveReportHeader` anywhere in the tree for it to have been.
   */
  it('offers no Live toggle', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText('System');
    expect(screen.queryByRole('button', { name: 'Live' })).toBeNull();
  });

  /**
   * The capability that DOES exist: `systemReportQuery.snapshotId`, which the
   * screen never offered. "Which point in time" is now a question with an
   * answer rather than a switch with none.
   */
  it('sends the chosen snapshot', async () => {
    const urls = mockApi();
    renderPage();
    await screen.findByLabelText('System');

    await userEvent.type(screen.getByLabelText('System'), 'sys-1');
    await userEvent.selectOptions(screen.getByLabelText('Point in time'), 's-old');
    await userEvent.click(screen.getByRole('button', { name: 'Run the report' }));

    await waitFor(() => expect(urls.some((u) => u.includes('snapshotId=s-old'))).toBe(true));
  });

  it('omits it for the latest, which is what the server defaults to', async () => {
    const urls = mockApi();
    renderPage();
    await screen.findByLabelText('System');

    await userEvent.type(screen.getByLabelText('System'), 'sys-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run the report' }));

    await waitFor(() =>
      expect(urls.some((u) => u.includes('/govern/reports/system?systemId=sys-1'))).toBe(true),
    );
    expect(urls.some((u) => u.includes('snapshotId='))).toBe(false);
  });
});
