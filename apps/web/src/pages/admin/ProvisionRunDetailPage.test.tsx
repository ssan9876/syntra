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
  error: null,
  requiresConfirmation: false,
  personsEvaluated: 4,
  personsUnprocessable: 0,
  actions: [action()],
  exceptions: [],
  ...overrides,
});

const finding = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  kind: 'unmanaged_entitlement',
  status: 'open',
  detail: { reason: 'the target holds this entitlement and Provision did not grant it' },
  ...overrides,
});

/**
 * Routes every request this page makes: the run, the drift, and the apply.
 *
 * `includes` rather than `endsWith` for the drift path: the page asks for
 * `/drift?status=open`, and a matcher anchored to the end of the string
 * silently routed that request to the run body instead.
 */
function mockFetch(
  body: Record<string, unknown>,
  drift: unknown[] | 'fails' = [],
  // Every field `applyProvisionRun` returns. The default used to name five of
  // the seven, which is the same omission the page itself had.
  applyResult: Record<string, unknown> = {
    status: 'applied',
    applied: 1,
    failed: 0,
    pendingRetry: 0,
    inFlight: 0,
    deferred: 0,
    skipped: 0,
  },
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    if (init?.method === 'POST') return Promise.resolve(json(applyResult));
    if (init?.method === 'PATCH') return Promise.resolve(json(null, 204));
    if (path.includes('/drift')) {
      return Promise.resolve(
        drift === 'fails'
          ? json({ title: 'Internal Server Error', status: 500 }, 500)
          : json({ findings: drift }),
      );
    }
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

/**
 * The apply notice, found by its heading.
 *
 * `role="alert"` is not a name-from-content role, so the container has no
 * accessible name to query it by and the heading is the handle.
 */
async function noticeHeaded(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title);
  const alert = heading.closest('[role="alert"]');
  expect(alert).not.toBeNull();
  return alert as HTMLElement;
}

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

  it('offers no apply at all for a block that cannot be confirmed away', async () => {
    // This fixture is the one the defect shipped under. The previous version of
    // this test rendered exactly it and asserted only that the confirmation
    // CHECKBOX was absent — it never looked at the Apply button sitting right
    // there, enabled, sending a request `apply.ts` refuses outright with
    // `ProvisionRunNotConfirmableError` and `provision-runs.ts` answers 409
    // `run-unconfirmable` to. There is no body that makes it succeed: no
    // `only`, no `confirm`. The button was the defect; the checkbox was its
    // neighbour.
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
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
    expect(screen.getByText('This run cannot be applied')).toBeVisible();
  });

  it('still offers the apply for a block that CAN be confirmed away', async () => {
    // The other half. A screen that refuses every blocked run is a screen that
    // makes the guard useless for the case it was built for: a real cohort
    // departure has to be processable by somebody who has read the numbers.
    mockFetch(
      run({
        status: 'blocked',
        requiresConfirmation: true,
        blockedReason: 'would disable 9 of 20 accounts (45.0%), above the 10% threshold',
      }),
    );
    renderPage();

    expect(await screen.findByText('This run is blocked')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply 1 action' })).toBeVisible();
    expect(screen.queryByText('This run cannot be applied')).toBeNull();
  });

  it('does not name every non-confirmable refusal, having named only two of five', async () => {
    // `guard.ts` returns `requiresConfirmation: false` from three places
    // covering five classes: a threshold or count that is not a number, no
    // persons on an active contract at all, a collapsed person population, a
    // target that returned no accounts, and any axis whose denominator is
    // missing. This screen used to explain all of them as one of two.
    mockFetch(
      run({
        status: 'blocked',
        requiresConfirmation: false,
        blockedReason:
          'cannot evaluate the revoke axis: the plan would revoke 4 entitlement holdings while the target inventory reports none at all, so the plan and the denominator did not come from the same read',
      }),
    );
    renderPage();

    expect(
      await screen.findByText(/cannot evaluate the revoke axis/),
    ).toBeVisible();
    // The old copy explained this run as an empty target or a broken HR feed.
    expect(
      screen.queryByText(/An empty target and an unreachable one/),
    ).toBeNull();
    expect(
      screen.queryByText(/signature of a broken feed/),
    ).toBeNull();
  });

  it('explains a superseded run as superseded, not as one partly applied', async () => {
    // Spec section 14's status list has no `superseded`, so `run-service.ts`
    // records it as `failed` with an explanatory `error`. The runs list already
    // maps this; the detail page told the reader that applying part of a run
    // ends it, which is not what happened to this one at all.
    mockFetch(
      run({ status: 'failed', error: 'superseded by a later run' }),
    );
    renderPage();

    expect(
      await screen.findByText(/A later run superseded this one/),
    ).toBeVisible();
    expect(screen.queryByText(/Applying part of a run ends it/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
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

  it('does not report a failed drift read as nothing being wrong', async () => {
    // The single most reassuring sentence on the screen was printed on the
    // evidence of a request that failed: the rejection was discarded and the
    // drift tab fell through to its empty state.
    mockFetch(run(), 'fails');
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /^Drift/ }));
    expect(screen.getByText('Drift could not be read')).toBeVisible();
    expect(screen.queryByText('No drift outstanding')).toBeNull();
    expect(
      screen.queryByText(/Everything at the target matches/),
    ).toBeNull();
  });

  it('does not count a drift read that failed as zero findings', async () => {
    mockFetch(run(), 'fails');
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Drift (unknown)' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Drift (0)' })).toBeNull();
  });

  it('asks for the open findings, not for every finding ever recorded', async () => {
    // The count included findings acknowledged and resolved months ago, and
    // `take: DRIFT_PAGE` with `orderBy: lastSeenAt desc` meant those stale rows
    // could crowd genuinely open ones off the end of the page.
    const fetchMock = mockFetch(run(), [finding()]);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Drift (1)' })).toBeVisible();
    const asked = fetchMock.mock.calls.map(([input]) => String(input));
    expect(asked.some((url) => url.includes('/drift?status=open'))).toBe(true);
  });

  it('says so when the drift count has been capped rather than reporting the cap as the total', async () => {
    // A count that silently caps is a count that lies at exactly the moment it
    // matters most. The server returns at most 500 findings in one read.
    const full = Array.from({ length: 500 }, (_, i) => finding({ id: `d${i}` }));
    mockFetch(run(), full);
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Drift (500+)' }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Drift (500+)' }));
    expect(screen.getByText('This list is not all of it')).toBeVisible();
  });

  it('reports every count the apply returned, not the three it used to', async () => {
    /*
     * Driven off the fixture rather than off a hand-written list of labels, so
     * that adding a field to the fixture — which is what a maintainer does when
     * the engine grows one — fails this test until the page renders it.
     *
     * Honest about its limit: `apps/web` has no compile-time or runtime link to
     * `applyProvisionRun`'s return type, so nothing in this package can fail
     * because the ENGINE grew a field. It fails when the fixture does.
     */
    const result = {
      status: 'partially_applied',
      applied: 12,
      failed: 2,
      pendingRetry: 3,
      inFlight: 1,
      deferred: 4,
      skipped: 7,
    };
    const numbers = Object.values(result).filter(
      (value): value is number => typeof value === 'number',
    );
    // Only worth anything while every count is distinct: two fields sharing a
    // value would let one of them go unrendered unnoticed.
    expect(new Set(numbers).size).toBe(numbers.length);

    mockFetch(run(), [], result);
    renderPage();

    await screen.findByText('Anna Novak');
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 action' }));

    const notice = await noticeHeaded('1 action is in flight');
    for (const value of numbers) {
      // Digit boundaries, not word boundaries. `textContent` puts no separator
      // between adjacent list items, so "12 actions applied" and "2 actions
      // failed" concatenate to `applied2 actions failed` and a word boundary
      // before that 2 never happens. This still cannot match the 2 inside 12.
      expect(notice, `count ${value}`).toHaveTextContent(
        new RegExp(`(?<![0-9])${value}(?![0-9])`),
      );
    }
    expect(notice).toHaveTextContent('The run is now partially_applied.');
  });

  it('does not let an in-flight action read as a plain success', async () => {
    // The one outcome whose truth is at the target and not in Syntra: the write
    // was attempted, and `resolveInFlightActions` has to ask the directory on
    // the next run whether it landed. Reported as "1 applied" it looks finished.
    mockFetch(run(), [], {
      status: 'partially_applied',
      applied: 1,
      failed: 0,
      pendingRetry: 0,
      inFlight: 1,
      deferred: 0,
      skipped: 0,
    });
    renderPage();

    await screen.findByText('Anna Novak');
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 action' }));

    const notice = await noticeHeaded('1 action is in flight');
    expect(notice).toHaveTextContent(/whether it landed is at the target, not here/);
    // And not wearing the tone a clean apply wears.
    expect(notice.className).toMatch(/danger/);
  });

  it('says how many actions were deferred for want of a confirmation', async () => {
    // A silent skip is how a target looks healthy while doing nothing (Ruling
    // P4), and on an unattended `autoApply` run nobody is watching it happen.
    // The counter was computed, returned, and then not shown.
    mockFetch(run(), [], {
      status: 'partially_applied',
      applied: 0,
      failed: 0,
      pendingRetry: 0,
      inFlight: 0,
      deferred: 3,
      skipped: 3,
    });
    renderPage();

    await screen.findByText('Anna Novak');
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 action' }));

    const notice = await noticeHeaded('3 actions were deferred');
    expect(notice).toHaveTextContent(
      /3 actions deferred — they require an explicit confirmation/,
    );
  });

  it('does not add the deferred to the skipped as though they were separate', async () => {
    // `apply.ts` computes `skipped` as `count(status: 'proposed')` after the
    // deferred actions have had their message written and their status left
    // alone, so the deferred are counted INSIDE it. "3 deferred and 5 skipped"
    // would be eight actions where there are five.
    mockFetch(run(), [], {
      status: 'partially_applied',
      applied: 1,
      failed: 0,
      pendingRetry: 0,
      inFlight: 0,
      deferred: 3,
      skipped: 5,
    });
    renderPage();

    await screen.findByText('Anna Novak');
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 action' }));

    const notice = await noticeHeaded('3 actions were deferred');
    expect(notice).toHaveTextContent(
      /5 actions were left unapplied altogether, the deferred among them/,
    );
  });

  it('reports a clean apply as a clean apply', async () => {
    // The half that keeps the other four worth reading: a notice that is always
    // amber is a notice nobody reads.
    mockFetch(run(), [], {
      status: 'applied',
      applied: 1,
      failed: 0,
      pendingRetry: 0,
      inFlight: 0,
      deferred: 0,
      skipped: 0,
    });
    renderPage();

    await screen.findByText('Anna Novak');
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 action' }));

    // The heading is `Applied`, not `1 action applied`: a heading that repeats
    // the first line of its own body reads as two facts and is one.
    const notice = await noticeHeaded('Applied');
    // Still says every state, including the zeros: a count printed only when it
    // is non-zero cannot be told from a count nobody computed.
    expect(notice).toHaveTextContent(/0 actions in flight/);
    expect(notice).toHaveTextContent(/0 actions deferred/);
    expect(notice).not.toHaveTextContent(/left unapplied altogether/);
    expect(notice.className).not.toMatch(/danger|warning/);
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
