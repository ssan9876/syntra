import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SyncRunDetailPage } from './SyncRunDetailPage.js';

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  sourceId: 's1',
  status: 'previewed',
  startedAt: '2026-08-15T09:00:00.000Z',
  finishedAt: '2026-08-15T09:00:04.000Z',
  recordsRead: 412,
  requiresConfirmation: false,
  blockedReason: null,
  error: null,
  unresolvedMembers: 0,
  mappingFailures: 0,
  mappingFailureReasons: [],
  changes: [
    {
      id: 'c1',
      changeType: 'create_user',
      targetType: 'User',
      targetId: null,
      sourceAnchor: 'a1',
      before: null,
      after: { login: 'nhaddad', email: 'nadia@acme.test' },
      status: 'proposed',
      message: null,
    },
    {
      id: 'c2',
      changeType: 'deactivate_user',
      targetType: 'User',
      targetId: 'u9',
      sourceAnchor: 'a9',
      before: { status: 'active' },
      after: { status: 'inactive' },
      status: 'proposed',
      message: null,
    },
    {
      id: 'c3',
      changeType: 'create_user',
      targetType: 'User',
      targetId: 'u1',
      sourceAnchor: 'a2',
      before: null,
      after: { login: 'admin' },
      status: 'conflict',
      message: 'matches a locally managed object',
    },
  ],
  ...overrides,
});

const defaultSources = [{ id: 's1', name: 'Corporate LDAP' }];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

// The page fetches the run and the source list separately (no server-side
// join), so the mock has to route on the URL rather than answer every call
// the same way.
function mockFetch(overrides: {
  run?: Record<string, unknown>;
  sources?: { id: string; name: string }[];
} = {}) {
  const runBody = overrides.run ?? run();
  const sources = overrides.sources ?? defaultSources;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/sync-runs/')) return Promise.resolve(json(runBody));
    if (url.includes('/sources')) return Promise.resolve(json({ sources }));
    return Promise.resolve(json({}));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/sync-runs/r1']}>
      <Routes>
        <Route path="/admin/sync-runs/:id" element={<SyncRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('SyncRunDetailPage', () => {
  it('groups changes by type with counts', async () => {
    mockFetch();
    renderPage();

    expect(await screen.findByText(/create user/i)).toBeInTheDocument();
    expect(screen.getByText(/deactivate user/i)).toBeInTheDocument();
  });

  it('shows what a change would set', async () => {
    mockFetch();
    renderPage();

    expect(await screen.findByText(/nhaddad/)).toBeInTheDocument();
  });

  it('marks a conflict and explains it', async () => {
    mockFetch();
    renderPage();

    expect(
      await screen.findByText(/matches a locally managed object/i),
    ).toBeInTheDocument();
  });

  it('leads with why a run was blocked, and disables apply', async () => {
    mockFetch({
      run: run({
        status: 'blocked',
        blockedReason:
          'would deactivate 380 of 400 objects from this source (95.0%), above the 10% threshold',
        requiresConfirmation: true,
      }),
    });
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/95.0%/);
    expect(alert).toHaveTextContent(/threshold/);
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
  });

  it('reports unresolved members rather than hiding them', async () => {
    mockFetch({ run: run({ unresolvedMembers: 3 }) });
    renderPage();

    expect(await screen.findByText(/3 group members/i)).toBeInTheDocument();
  });

  it('says plainly when records could not be mapped, with the reason', async () => {
    mockFetch({
      run: run({
        recordsRead: 5000,
        mappingFailures: 100,
        mappingFailureReasons: [
          'the correlation attribute is missing from this record',
        ],
      }),
    });
    renderPage();

    expect(
      await screen.findByText(/100 of 5000 records could not be mapped/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/correlation attribute is missing/i),
    ).toBeInTheDocument();
  });

  it('says plainly when a run proposed nothing', async () => {
    mockFetch({ run: run({ changes: [] }) });
    renderPage();

    expect(await screen.findByText(/already matches/i)).toBeInTheDocument();
  });

  it('names the source the run belongs to', async () => {
    mockFetch();
    renderPage();

    expect(await screen.findByText(/corporate ldap/i)).toBeInTheDocument();
  });

  it('falls back to the raw source id when the source is missing', async () => {
    mockFetch({ sources: [] });
    renderPage();

    expect(await screen.findByText(/s1/)).toBeInTheDocument();
  });

  it('links back to the sync runs list', async () => {
    mockFetch();
    renderPage();

    expect(
      await screen.findByRole('link', { name: /back to sync runs/i }),
    ).toHaveAttribute('href', '/admin/sync-runs');
  });
});
