import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RunsTab } from './RunsTab.js';

const syncRuns = [
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

const importRuns = [
  {
    id: 'i1',
    sourceId: 'p1',
    status: 'applied',
    startedAt: '2026-08-16T02:00:00.000Z',
    finishedAt: '2026-08-16T02:00:09.000Z',
    recordsRead: 812,
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

// Four separate GETs with no server-side join, so the mock routes on the URL.
// The person-source paths must be matched BEFORE the directory ones: both
// '/api/admin/person-sources' and '/api/admin/sources' contain "/sources".
function mockFetch(
  overrides: {
    syncRuns?: Record<string, unknown>[];
    importRuns?: Record<string, unknown>[];
    sources?: { id: string; name: string }[];
    personSources?: { id: string; name: string }[];
  } = {},
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/person-import-runs')) {
      return Promise.resolve(json({ runs: overrides.importRuns ?? importRuns }));
    }
    if (url.includes('/person-sources')) {
      return Promise.resolve(
        json({ sources: overrides.personSources ?? [{ id: 'p1', name: 'HR nightly' }] }),
      );
    }
    if (url.includes('/sync-runs')) {
      return Promise.resolve(json({ runs: overrides.syncRuns ?? syncRuns }));
    }
    if (url.includes('/sources')) {
      return Promise.resolve(
        json({ sources: overrides.sources ?? [{ id: 's1', name: 'Corporate LDAP' }] }),
      );
    }
    return Promise.resolve(json({}));
  });
}

const renderTab = () =>
  render(
    <MemoryRouter>
      <RunsTab />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('RunsTab', () => {
  /**
   * One list, not two. "What ran last night and what did it do" is one
   * question, and a tab each means a blocked import can sit unnoticed beside
   * a healthy directory sync.
   */
  it('lists both families in one table', async () => {
    mockFetch();
    renderTab();

    expect(await screen.findByText('Corporate LDAP')).toBeVisible();
    expect(screen.getByText('HR nightly')).toBeVisible();
    // Two directory runs in the fixture, so this column repeats.
    expect(screen.getAllByText('Directory')).toHaveLength(2);
    expect(screen.getAllByText('People')).toHaveLength(1);
  });

  it('sends each family to its own detail page', async () => {
    mockFetch();
    renderTab();

    const links = await screen.findAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/admin/sync-runs/r1');
    expect(hrefs).toContain('/admin/person-import-runs/i1');
  });

  /** Newest first, across families -- otherwise the merge reads as two lists. */
  it('orders by start time across both families', async () => {
    mockFetch();
    renderTab();

    const links = await screen.findAllByRole('link');
    // i1 (16 Aug) before r1 (15 Aug) before r2 (14 Aug).
    expect(links[0]?.getAttribute('href')).toBe('/admin/person-import-runs/i1');
    expect(links[1]?.getAttribute('href')).toBe('/admin/sync-runs/r1');
  });

  it('shows blocked in the danger tone so it is unmissable', async () => {
    mockFetch();
    renderTab();
    const blocked = await screen.findByText('Blocked');
    expect(blocked.className).toMatch(/danger/);
  });

  it('labels a partially applied run rather than printing its raw status', async () => {
    mockFetch({
      importRuns: [{ ...importRuns[0]!, status: 'partially_applied' }],
    });
    renderTab();
    expect(await screen.findByText('Partially applied')).toBeVisible();
  });

  it('names the source a run belongs to, not its raw id', async () => {
    mockFetch();
    renderTab();
    expect(await screen.findByText('Corporate LDAP')).toBeVisible();
    expect(screen.queryByText('s1')).toBeNull();
  });

  it('falls back to the raw source id when the source is no longer listed', async () => {
    mockFetch();
    renderTab();
    expect(await screen.findByText('s-missing')).toBeVisible();
  });

  it('shows an empty state naming the next action', async () => {
    mockFetch({ syncRuns: [], importRuns: [] });
    renderTab();
    expect(await screen.findByText('No runs yet')).toBeVisible();
  });
});
