import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CancelRunButton, CancellationStatus, isCancellable } from './RunCancellation.js';
import { SyncRunDetailPage } from './SyncRunDetailPage.js';
import { ProvisionRunDetailPage } from './ProvisionRunDetailPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CancelRunButton', () => {
  it('asks first, says what stopping a working run means, then posts', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ outcome: 'requested' }));
    const onChanged = vi.fn();
    render(
      <CancelRunButton
        path="/api/admin/sync-runs/r1/cancel"
        run={{ status: 'applying', cancelState: null }}
        working={['running', 'applying']}
        noun="sync run"
        onChanged={onChanged}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    // Nothing sent on the first click: the confirmation is the decision.
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/stops at its next checkpoint/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Cancel this sync run' });
    expect(confirm).toHaveFocus();

    await userEvent.click(confirm);

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/sync-runs/r1/cancel',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('says a waiting run is cancelled now, and backing out sends nothing', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    render(
      <CancelRunButton
        path="/api/admin/targets/t1/runs/r1/cancel"
        run={{ status: 'previewed', cancelState: null }}
        working={['running', 'applying']}
        noun="provisioning run"
        onChanged={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(screen.getByText(/so it is cancelled now/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toHaveFocus();
  });

  it("shows the server's reason when the run has already finished", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          type: 'https://syntra.dev/problems/run-not-cancellable',
          title: 'This run has already finished',
          status: 409,
          detail: 'run r1 is applied, which has nothing left to cancel',
        },
        409,
      ),
    );
    render(
      <CancelRunButton
        path="/api/admin/sync-runs/r1/cancel"
        run={{ status: 'running', cancelState: null }}
        working={['running']}
        noun="sync run"
        onChanged={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel this sync run' }));

    expect(
      await screen.findByText('run r1 is applied, which has nothing left to cancel'),
    ).toBeInTheDocument();
  });
});

describe('CancellationStatus', () => {
  it('announces each state politely', () => {
    const { rerender } = render(
      <CancellationStatus run={{ status: 'applying', cancelState: 'requested' }} noun="import run" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Cancellation requested');

    rerender(<CancellationStatus run={{ status: 'cancelled', cancelState: 'cancelled' }} noun="import run" />);
    expect(screen.getByRole('status')).toHaveTextContent('This import run was cancelled');

    rerender(<CancellationStatus run={{ status: 'applied', cancelState: 'moot' }} noun="import run" />);
    expect(screen.getByRole('status')).toHaveTextContent('Cancellation arrived too late');

    rerender(<CancellationStatus run={{ status: 'applied', cancelState: null }} noun="import run" />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('offers nothing to cancel once a request is waiting or the run is over', () => {
    const live = ['running', 'applying', 'previewed'];
    expect(isCancellable({ status: 'applying', cancelState: null }, live)).toBe(true);
    expect(isCancellable({ status: 'applying', cancelState: 'requested' }, live)).toBe(false);
    expect(isCancellable({ status: 'applied', cancelState: 'moot' }, live)).toBe(false);
  });
});

describe('the run pages', () => {
  const syncRun = (overrides: Record<string, unknown>) => ({
    id: 'r1',
    sourceId: 's1',
    status: 'previewed',
    startedAt: '2026-08-15T09:00:00.000Z',
    finishedAt: null,
    recordsRead: 3,
    requiresConfirmation: false,
    blockedReason: null,
    error: null,
    unresolvedMembers: 0,
    mappingFailures: 0,
    mappingFailureReasons: [],
    cancelState: null,
    cancelRequestedAt: null,
    cancelResolvedAt: null,
    changes: [],
    ...overrides,
  });

  const renderSync = (run: Record<string, unknown>) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/sync-runs/')) return Promise.resolve(json(run));
      return Promise.resolve(json({ sources: [] }));
    });
    return render(
      <MemoryRouter initialEntries={['/admin/sync-runs/r1']}>
        <Routes>
          <Route path="/admin/sync-runs/:id" element={<SyncRunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('offers Cancel on a sync run that is still applying', async () => {
    renderSync(syncRun({ status: 'applying' }));
    expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    expect(screen.getByText('Applying changes')).toBeInTheDocument();
  });

  it('shows a waiting request instead of a second Cancel button', async () => {
    renderSync(syncRun({ status: 'applying', cancelState: 'requested', cancelRequestedAt: '2026-08-15T09:00:02.000Z' }));
    expect(await screen.findByText('Cancellation requested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
  });

  it('offers no Cancel on a cancelled sync run and says what was kept', async () => {
    renderSync(syncRun({ status: 'cancelled', cancelState: 'cancelled' }));
    expect(await screen.findByText('This sync run was cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
  });

  it('offers Cancel on a provisioning run awaiting review and posts to its target', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/cancel')) return Promise.resolve(json({ outcome: 'cancelled' }));
      if (url.includes('/drift')) return Promise.resolve(json({ findings: [] }));
      if (url.includes('/runs/r1')) {
        return Promise.resolve(
          json({
            id: 'r1',
            status: 'previewed',
            startedAt: '2026-08-15T09:00:00.000Z',
            blockedReason: null,
            error: null,
            requiresConfirmation: false,
            personsEvaluated: 1,
            personsUnprocessable: 0,
            cancelState: null,
            actions: [],
            exceptions: [],
          }),
        );
      }
      return Promise.resolve(json({}));
    });
    render(
      <MemoryRouter initialEntries={['/admin/targets/t1/runs/r1']}>
        <Routes>
          <Route path="/admin/targets/:id/runs/:runId" element={<ProvisionRunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel this provisioning run' }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/targets/t1/runs/r1/cancel',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
