import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PersonImportRunDetailPage } from './PersonImportRunDetailPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  sourceId: 's1',
  status: 'previewed',
  recordsRead: 812,
  mappingFailures: 0,
  mappingFailureReasons: [],
  personsAbsent: 0,
  requiresConfirmation: false,
  blockedReason: null,
  error: null,
  ...over,
});

const change = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  changeType: 'update_person',
  recordType: 'person',
  externalId: '5',
  status: 'proposed',
  message: null,
  after: null,
  ...over,
});

function mockFetch(payload: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      json({
        run: run(),
        changes: [],
        denominators: { activePersonsFromSource: 812 },
        ...payload,
      }),
    ),
  );
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/person-import-runs/r1']}>
      <Routes>
        <Route
          path="/admin/person-import-runs/:id"
          element={<PersonImportRunDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('reviewing an import run', () => {
  /**
   * The count against the denominator the guard measured, so the confirming
   * administrator reads the same number the refusal came from rather than a
   * bare count.
   */
  it('shows leavers first, with the count against its denominator', async () => {
    mockFetch({
      run: run({ personsAbsent: 2 }),
      changes: [
        change(),
        change({ id: 'c2', changeType: 'depart_person', externalId: '9' }),
        change({ id: 'c3', changeType: 'depart_person', externalId: '11' }),
      ],
    });
    renderPage();

    expect(await screen.findByText('2 of 812 people this source owns')).toBeVisible();
    const headings = screen.getAllByRole('heading');
    const leavers = headings.findIndex((h) => /leavers/i.test(h.textContent ?? ''));
    const others = headings.findIndex((h) => /people to update/i.test(h.textContent ?? ''));
    expect(leavers).toBeLessThan(others);
  });

  /**
   * populationDropRefusal returns a complete sentence for the reason its own
   * comment gives: a refusal that carries its own sentence is one the caller
   * cannot paraphrase into something less specific. So it is printed.
   */
  it('prints a blocked run’s reason verbatim', async () => {
    const reason =
      'the number of people holding an active contract has fallen from 800 to 40 ' +
      '(95.0%), above the 10% limit; this is the signature of a broken HR feed, ' +
      'and every action in this import is downstream of that count';
    mockFetch({
      run: run({ status: 'blocked', requiresConfirmation: true, blockedReason: reason }),
    });
    renderPage();
    expect(await screen.findByText(reason)).toBeVisible();
  });

  /**
   * An empty file and an unreachable server are indistinguishable, so there is
   * nothing a human could usefully confirm and no apply action is offered.
   */
  it('offers no apply action on a run that read nothing', async () => {
    mockFetch({
      run: run({
        status: 'blocked',
        requiresConfirmation: false,
        recordsRead: 0,
        blockedReason: 'the source returned no records',
      }),
    });
    renderPage();

    expect(await screen.findByText(/returned no records/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('offers a confirming apply on an over-threshold run', async () => {
    mockFetch({
      run: run({
        status: 'blocked',
        requiresConfirmation: true,
        blockedReason: 'would depart 37 of 100 people this source owns',
      }),
    });
    renderPage();
    expect(
      await screen.findByRole('button', { name: /i have read the numbers/i }),
    ).toBeVisible();
  });

  /**
   * Read but excluded, and explicitly NOT leavers -- which is what stops a
   * column rename at the vendor reading as a redundancy.
   */
  it('shows mapping failures as read-but-excluded, not as leavers', async () => {
    mockFetch({
      run: run({
        mappingFailures: 3,
        mappingFailureReasons: ['the correlation column is missing or empty in this row'],
      }),
    });
    renderPage();

    expect(await screen.findByText(/3 rows were read but could not be mapped/i)).toBeVisible();
    expect(screen.getByText(/not treated as leavers/i)).toBeVisible();
  });

  it('says so when a run proposes nothing', async () => {
    mockFetch({ changes: [] });
    renderPage();
    expect(await screen.findByText(/nothing to apply/i)).toBeVisible();
  });
});
