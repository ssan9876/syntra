import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProvisionRunDetailPage } from './ProvisionRunDetailPage.js';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const action = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  actionType: 'create_account',
  status: 'proposed',
  message: null,
  requiresConfirmation: false,
  sequence: 0,
  attributedRuleIds: [],
  person: { id: 'p1', givenName: 'Anna', familyName: 'Novak' },
  ...overrides,
});

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'previewed',
  startedAt: '2026-08-01T03:00:00.000Z',
  blockedReason: null,
  requiresConfirmation: false,
  personsEvaluated: 4,
  personsUnprocessable: 0,
  actions: [action()],
  exceptions: [],
  ...overrides,
});

/** Routes every request this page makes: the run, the drift, and the apply. */
function mockFetch(
  body: Record<string, unknown>,
  drift: unknown[] = [],
  applyResult: Record<string, unknown> = {
    status: 'applied',
    applied: 1,
    failed: 0,
    skipped: 0,
    pendingRetry: 0,
  },
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    if (init?.method === 'POST') return Promise.resolve(json(applyResult));
    if (init?.method === 'PATCH') return Promise.resolve(json(null, 204));
    if (path.endsWith('/drift')) return Promise.resolve(json({ findings: drift }));
    return Promise.resolve(json(body));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/targets/t1/runs/r1']}>
      <Routes>
        <Route
          path="/admin/targets/:id/runs/:runId"
          element={<ProvisionRunDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('ProvisionRunDetailPage', () => {
  it('offers a way past a block that can be confirmed', async () => {
    mockFetch(
      run({
        status: 'blocked',
        requiresConfirmation: true,
        blockedReason:
          'this target has never had a run applied; the create population is 100% of 1',
      }),
    );
    renderPage();

    expect(await screen.findByText('This run is blocked')).toBeVisible();
    // Split on the separator the guard joins its reasons with, so a run with
    // three reasons reads as three reasons.
    expect(
      screen.getByText('this target has never had a run applied'),
    ).toBeVisible();
    expect(
      screen.getByText('the create population is 100% of 1'),
    ).toBeVisible();
    expect(
      screen.getByLabelText(
        'I have read the numbers above and want to apply this run anyway',
      ),
    ).toBeVisible();
  });

  it('offers no confirmation at all for a block that cannot be confirmed away', async () => {
    // The guard's most important property: some refusals cannot be waved
    // through. A tick rendered here would be a tick the server refuses, and
    // an administrator would read the refusal as a bug rather than as the
    // control working.
    mockFetch(
      run({
        status: 'blocked',
        requiresConfirmation: false,
        blockedReason: 'the target returned no accounts at all',
      }),
    );
    renderPage();

    expect(await screen.findByText('This run is blocked')).toBeVisible();
    expect(screen.getByText(/cannot be confirmed away/)).toBeVisible();
    expect(
      screen.queryByLabelText(
        'I have read the numbers above and want to apply this run anyway',
      ),
    ).toBeNull();
  });

  it('says a run that proposes nothing proposes nothing', async () => {
    // Convergence. An empty plan and a plan that failed to compute look
    // identical otherwise, and the empty case is the one this slice keeps
    // getting wrong.
    mockFetch(run({ actions: [] }));
    renderPage();

    expect(await screen.findByText('This run proposes nothing')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
  });

  it('sends exactly the actions still ticked', async () => {
    const second = action({
      id: '22222222-2222-4222-8222-222222222222',
      actionType: 'grant_entitlement',
      sequence: 1,
    });
    const fetchMock = mockFetch(run({ actions: [action(), second] }));
    renderPage();

    await screen.findByText('Anna Novak');
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Apply grant_entitlement for Anna Novak',
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Apply 1 action' }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 action' }));

    const posted = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posted).toBeDefined();
    expect(
      JSON.parse(String((posted![1] as RequestInit).body)),
    ).toEqual({ only: [action().id], confirm: false });
  });

  it('will not apply an action needing confirmation without one', async () => {
    // A rename, or a re-enable outside the window, in a run the guard did not
    // block at all. The run-level tick is not on screen, so without this the
    // button would send `confirm: false` and the server would refuse it.
    mockFetch(run({ actions: [action({ requiresConfirmation: true })] }));
    renderPage();

    await screen.findByText('needs confirmation');
    expect(screen.getByRole('button', { name: 'Apply 1 action' })).toBeDisabled();

    await userEvent.click(
      // A substring: `Check` puts its hint inside the same wrapping label, so
      // the accessible name carries the explanation as well as the sentence.
      screen.getByLabelText(/I have read what needs confirmation/),
    );
    expect(screen.getByRole('button', { name: 'Apply 1 action' })).toBeEnabled();
  });

  it('will not tick an action the run has already decided', async () => {
    mockFetch(run({ actions: [action({ status: 'applied' })] }));
    renderPage();

    await screen.findByText('Anna Novak');
    expect(
      screen.getByRole('checkbox', {
        name: 'Apply create_account for Anna Novak',
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Apply 0 actions' }),
    ).toBeDisabled();
  });

  it('leads with the persons it could not process', async () => {
    // Every person on that list is a person whose access is frozen until
    // somebody fixes something.
    mockFetch(
      run({
        exceptions: [
          {
            id: 'e1',
            kind: 'unresolvable_rule',
            message: 'the rule names an entitlement that is missing',
            person: { id: 'p2', givenName: 'Rin', familyName: 'Fujimoto' },
          },
        ],
      }),
    );
    renderPage();

    expect(
      await screen.findByText('1 person could not be processed'),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Exceptions (1)' }));
    expect(screen.getByText('Rin Fujimoto')).toBeVisible();
  });

  it('offers no second apply for a run that has already been partly applied', async () => {
    // `APPLIABLE_RUN_STATUSES` in apply.ts is ['previewed', 'blocked'], so
    // applying part of a run ENDS it: the remainder is superseded by the next
    // preview. A button here would send a request the engine answers 409 to,
    // and the copy under it would promise a second bite the engine does not
    // give. Found by reading apply.ts rather than by any test — the plan's own
    // end-to-end script drove exactly this second apply.
    mockFetch(run({ status: 'partially_applied' }));
    renderPage();

    expect(
      await screen.findByText('Nothing further to apply'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  });

  it('still offers the apply for a run nothing has been written from', async () => {
    mockFetch(run({ status: 'previewed' }));
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Apply 1 action' }),
    ).toBeVisible();
    expect(screen.queryByText('Nothing further to apply')).toBeNull();
  });

  it('names an action attributed to nobody rather than dropping it', async () => {
    // `ProvisionAction.personId` is nullable, and an action nobody owns is
    // still an action about to be written to a live directory.
    mockFetch(run({ actions: [action({ person: null })] }));
    renderPage();

    expect(
      await screen.findByText('Not attributed to a person'),
    ).toBeVisible();
  });
});
