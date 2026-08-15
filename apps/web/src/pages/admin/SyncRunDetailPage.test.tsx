import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SyncRunDetailPage } from './SyncRunDetailPage.js';

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'previewed',
  startedAt: '2026-08-15T09:00:00.000Z',
  finishedAt: '2026-08-15T09:00:04.000Z',
  recordsRead: 412,
  requiresConfirmation: false,
  blockedReason: null,
  error: null,
  unresolvedMembers: 0,
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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(run()));
    renderPage();

    expect(await screen.findByText(/create user/i)).toBeInTheDocument();
    expect(screen.getByText(/deactivate user/i)).toBeInTheDocument();
  });

  it('shows what a change would set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(run()));
    renderPage();

    expect(await screen.findByText(/nhaddad/)).toBeInTheDocument();
  });

  it('marks a conflict and explains it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(run()));
    renderPage();

    expect(
      await screen.findByText(/matches a locally managed object/i),
    ).toBeInTheDocument();
  });

  it('leads with why a run was blocked, and disables apply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        run({
          status: 'blocked',
          blockedReason:
            'would deactivate 380 of 400 objects from this source (95.0%), above the 10% threshold',
          requiresConfirmation: true,
        }),
      ),
    );
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/95.0%/);
    expect(alert).toHaveTextContent(/threshold/);
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
  });

  it('reports unresolved members rather than hiding them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(run({ unresolvedMembers: 3 })),
    );
    renderPage();

    expect(await screen.findByText(/3 group members/i)).toBeInTheDocument();
  });

  it('says plainly when a run proposed nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(run({ changes: [] })));
    renderPage();

    expect(await screen.findByText(/already matches/i)).toBeInTheDocument();
  });
});
