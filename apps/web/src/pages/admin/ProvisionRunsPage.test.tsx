import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { ProvisionRunsPage } from './ProvisionRunsPage.js';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'applied',
  startedAt: '2026-08-01T03:00:00.000Z',
  personsEvaluated: 40,
  personsUnprocessable: 0,
  blockedReason: null,
  error: null,
  ...overrides,
});

function mockFetch(options: { runs?: unknown[]; postProblem?: unknown } = {}) {
  const runs = options.runs ?? [run()];
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (init?.method === 'POST') {
      return Promise.resolve(
        options.postProblem
          ? json(options.postProblem, 503)
          : json({ jobId: 'j1' }, 202),
      );
    }
    void input;
    return Promise.resolve(json({ runs }));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/targets/t1/runs']}>
      <Routes>
        <Route path="/admin/targets/:id/runs" element={<ProvisionRunsPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('ProvisionRunsPage', () => {
  it('reads a superseded run as superseded rather than as a failure', async () => {
    // Spec section 14's status list has no `superseded`, so
    // `adoptStaleRunsAndStart` records one as `failed` with
    // `error: 'superseded by a later run'`. Rendering that as red puts routine
    // supersedes and genuine failures in one bucket and trains people to
    // ignore red.
    mockFetch({
      runs: [run({ status: 'failed', error: 'superseded by a later run' })],
    });
    renderPage();

    expect(await screen.findByText('superseded')).toBeVisible();
    expect(screen.queryByText('failed')).toBeNull();
  });

  it('keeps a genuine failure red', async () => {
    // The half that makes the other half worth anything.
    mockFetch({
      runs: [
        run({
          id: 'r2',
          status: 'failed',
          error: 'this run was left running by a process that did not finish',
        }),
      ],
    });
    renderPage();

    const failed = await screen.findByText('failed');
    expect(failed.className).toMatch(/danger/);
  });

  it('gives a superseded run a different tone from a failed one', async () => {
    mockFetch({
      runs: [
        run({ id: 'r1', status: 'failed', error: 'superseded by a later run' }),
        run({ id: 'r2', status: 'failed', error: 'the bind was refused' }),
      ],
    });
    renderPage();

    const superseded = await screen.findByText('superseded');
    expect(superseded.className).not.toBe(screen.getByText('failed').className);
  });

  it('leads with the persons a run could not process', async () => {
    // Every one of them is a person whose access is frozen until somebody
    // fixes something, and a zero and a nine must not read the same.
    mockFetch({ runs: [run({ personsUnprocessable: 9 })] });
    renderPage();

    const cell = await screen.findByText('9');
    expect(cell.className).toMatch(/danger/);
  });

  it('says what a run is when a target has never had one', async () => {
    // The state every target is in the minute after it is created, and an
    // empty table says nothing about what the missing thing would be.
    mockFetch({ runs: [] });
    renderPage();

    expect(await screen.findByText('No runs yet')).toBeVisible();
  });

  it('says a queued run is queued rather than pretending it has started', async () => {
    // `POST /targets/:id/runs` enqueues and answers 202 with a job id: a full
    // target read outlasts a proxy timeout, so the row appears when the worker
    // picks the job up, not when the button is released.
    mockFetch({ runs: [] });
    renderPage();

    await screen.findByText('No runs yet');
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    expect(
      await screen.findByText(/A run has been queued/),
    ).toBeVisible();
  });

  it('says the scheduler is not running when it is not', async () => {
    // The route answers 503 `scheduler-unavailable` when the API is up and the
    // job scheduler is not, and its `detail` is the sentence that explains why
    // nothing appeared.
    mockFetch({
      runs: [],
      postProblem: {
        type: 'x/scheduler-unavailable',
        title: 'Background jobs are not running',
        status: 503,
        detail:
          'the run could not be enqueued; the API is up but the job scheduler is not',
      },
    });
    renderPage();

    await screen.findByText('No runs yet');
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    expect(
      await screen.findByText(
        'the run could not be enqueued; the API is up but the job scheduler is not',
      ),
    ).toBeVisible();
  });

  it('does not let a stale response for a previous target overwrite a rapid id change', async () => {
    // The runs request for t1 is left pending; the one for t2 answers first,
    // as it would if t1's happened to be the slower of the two round trips.
    // Resolving t1's afterwards must not clobber what t2 already rendered.
    let resolveStale: () => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/targets/t1/runs')) {
        return new Promise((resolve) => {
          resolveStale = () =>
            resolve(json({ runs: [run({ id: 'stale', personsEvaluated: 999 })] }));
        });
      }
      if (url.includes('/targets/t2/runs')) {
        return Promise.resolve(
          json({ runs: [run({ id: 'fresh', personsEvaluated: 5 })] }),
        );
      }
      return Promise.resolve(json({ runs: [] }));
    });

    function Nav() {
      const navigate = useNavigate();
      return (
        <button onClick={() => navigate('/admin/targets/t2/runs')}>
          switch
        </button>
      );
    }

    render(
      <MemoryRouter initialEntries={['/admin/targets/t1/runs']}>
        <Nav />
        <Routes>
          <Route
            path="/admin/targets/:id/runs"
            element={<ProvisionRunsPage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(await screen.findByText('5')).toBeVisible();

    resolveStale();
    // Give the stale promise a turn to settle before asserting it changed
    // nothing.
    await screen.findByText('5');
    expect(screen.queryByText('999')).toBeNull();
  });
});
