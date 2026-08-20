import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SyncRunDetailPage } from './SyncRunDetailPage.js';

/**
 * A run is a background JOB now, so the page an administrator lands on after
 * pressing "Run now" is a page about a run that has not happened yet.
 *
 * Its own file because it drives fake timers, and installing those around the
 * rest of `SyncRunDetailPage.test.tsx` would change how every one of its
 * `userEvent` cases behaves.
 */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const run = (status: string) => ({
  id: 'r1',
  sourceId: 's1',
  status,
  startedAt: '2026-08-15T09:00:00.000Z',
  finishedAt: null,
  recordsRead: 0,
  requiresConfirmation: false,
  blockedReason: null,
  error: null,
  unresolvedMembers: 0,
  mappingFailures: 0,
  mappingFailureReasons: [],
  changes: [],
});

/** Counts run fetches, and can change its answer partway through. */
function mockFetch(statuses: string[]) {
  const runFetches = { count: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/sync-runs/')) {
      const status = statuses[Math.min(runFetches.count, statuses.length - 1)]!;
      runFetches.count += 1;
      return Promise.resolve(json(run(status)));
    }
    if (url.includes('/sources')) {
      return Promise.resolve(json({ sources: [{ id: 's1', name: 'Head office' }] }));
    }
    return Promise.resolve(json({}));
  });
  return runFetches;
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/sync-runs/r1']}>
      <Routes>
        <Route path="/admin/sync-runs/:id" element={<SyncRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a run that has not finished', () => {
  it('says QUEUED means not started, rather than showing an empty run', async () => {
    // The distinction an administrator needs before concluding their directory
    // is unreachable: the job has not begun. An empty change list with no
    // explanation reads as a run that found nothing.
    mockFetch(['queued']);
    renderPage();

    expect(await screen.findByText(/has not started yet/i)).toBeInTheDocument();
  });

  it('distinguishes reading the directory from waiting for a worker', async () => {
    mockFetch(['running']);
    renderPage();

    expect(await screen.findByText(/Reading the directory/i)).toBeInTheDocument();
    expect(screen.queryByText(/has not started yet/i)).toBeNull();
  });

  it('follows the run rather than leaving the reader to refresh', async () => {
    const fetches = mockFetch(['queued']);
    renderPage();
    await screen.findByText(/has not started yet/i);

    const before = fetches.count;
    // Inside `act`: advancing the timer fires the poll, whose resolution sets
    // state, and React warns about state set outside `act` for good reason —
    // an assertion that runs before the render it triggered is an assertion
    // about the previous frame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // Three intervals at two seconds. Without the poll this stays put and the
    // page an administrator was just sent to never changes.
    expect(fetches.count).toBeGreaterThan(before);
  });

  it('STOPS polling once the run has settled', async () => {
    // A settled run is a row that will never change again. Polling it forever
    // is a request per viewer per interval, for nothing.
    const fetches = mockFetch(['previewed']);
    renderPage();
    await waitFor(() => expect(fetches.count).toBeGreaterThan(0));

    const before = fetches.count;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetches.count).toBe(before);
  });
});
