import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SyncRunsPage } from './SyncRunsPage.js';

const runs = [
  {
    id: 'r1',
    sourceId: 's1',
    status: 'previewed',
    startedAt: '2026-08-15T09:00:00.000Z',
    finishedAt: '2026-08-15T09:00:04.000Z',
    recordsRead: 412,
  },
  {
    id: 'r2',
    sourceId: 's-missing',
    status: 'blocked',
    startedAt: '2026-08-14T09:00:00.000Z',
    finishedAt: null,
    recordsRead: 400,
  },
];

const defaultSources = [{ id: 's1', name: 'Corporate LDAP' }];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

// Two separate GETs (runs, sources) with no server-side join, so the mock
// has to route on the URL rather than answer every call the same way.
function mockFetch(overrides: {
  runs?: Record<string, unknown>[];
  sources?: { id: string; name: string }[];
} = {}) {
  const runsBody = overrides.runs ?? runs;
  const sources = overrides.sources ?? defaultSources;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/sync-runs')) return Promise.resolve(json({ runs: runsBody }));
    if (url.includes('/sources')) return Promise.resolve(json({ sources }));
    return Promise.resolve(json({}));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <SyncRunsPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('SyncRunsPage', () => {
  it('shows blocked in the danger tone so it is unmissable', async () => {
    mockFetch();
    renderPage();

    const row = (await screen.findByText(/blocked/i)).closest('tr')!;
    expect(row).toBeInTheDocument();
  });

  it('names the source a run belongs to, not its raw id', async () => {
    mockFetch();
    renderPage();

    expect(await screen.findByText('Corporate LDAP')).toBeInTheDocument();
    expect(screen.queryByText('s1')).not.toBeInTheDocument();
  });

  it('falls back to the raw source id when a run references a source no longer in the list', async () => {
    mockFetch();
    renderPage();

    expect(await screen.findByText('s-missing')).toBeInTheDocument();
  });

  it('shows an empty state naming the next action', async () => {
    mockFetch({ runs: [] });
    renderPage();

    expect(await screen.findByText(/no sync runs yet/i)).toBeInTheDocument();
  });
});
