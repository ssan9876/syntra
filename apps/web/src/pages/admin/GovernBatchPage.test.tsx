import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GovernBatchPage } from './GovernBatchPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const dispatch = (overrides: Record<string, unknown> = {}) => ({
  id: 'd-1',
  route: 'revocation_order',
  status: 'proposed',
  message: null,
  sequence: 0,
  holdingDescriptor: { subjectKey: 'Anna Admin', resourceName: 'Domain Admins' },
  ...overrides,
});

const body = (
  batch: Record<string, unknown>,
  dispatches: ReturnType<typeof dispatch>[],
): unknown => ({
  batch: {
    id: 'b-1',
    status: 'previewed',
    requiresConfirmation: false,
    blockedReason: null,
    proposedCount: dispatches.length,
    requiresChangeCount: 0,
    dispatchedCount: 0,
    failedCount: 0,
    ...batch,
  },
  dispatches,
  withheldOutOfScope: 0,
});

const renderPage = (payload: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async () => json(payload)));
  render(
    <MemoryRouter initialEntries={['/admin/govern/batches/b-1']}>
      <Routes>
        <Route path="/admin/govern/batches/:id" element={<GovernBatchPage />} />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('GovernBatchPage', () => {
  it('leads a blocked batch with WHY, above the rows, and will not let it be confirmed', async () => {
    renderPage(
      body(
        {
          status: 'blocked',
          blockedReason:
            'the snapshot this batch was computed from is 41 days old, against a 30-day maximum',
        },
        [dispatch(), dispatch({ id: 'd-2', holdingDescriptor: { subjectKey: 'Ben Baker' } })],
      ),
    );

    const reason = await screen.findByText(/41 days old/);
    const table = screen.getByRole('table');
    // ABOVE, asserted against the DOM rather than against a screenshot. A
    // reason printed under sixty rows is a reason nobody reads before they
    // reach for the button — the same screen shape as Directory Sync's blocked
    // run and Provision's blocked plan.
    expect(reason.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByRole('button', { name: /Confirm and dispatch/ })).toBeDisabled();
  });

  it('keeps a requires_change row out of the dispatchable count and in its own panel', async () => {
    renderPage(
      body({ requiresChangeCount: 1 }, [
        dispatch(),
        dispatch({ id: 'd-2', holdingDescriptor: { subjectKey: 'Ben Baker' } }),
        dispatch({
          id: 'd-3',
          route: 'requires_change_rule',
          holdingDescriptor: {
            subjectKey: 'Cora Clark',
            resourceName: 'Ledger reader',
            explanation: 'a business rule grants this, and the rule has to change first',
            notRemoved: ['the rule “Finance staff get the ledger”'],
          },
        }),
      ]),
    );

    // TWO, not three. The count on the panel is what an administrator reads
    // before they press an irreversible button, and a `requires_change` row
    // removes nothing.
    expect(
      await screen.findByRole('heading', { name: '2 removals Govern can dispatch' }),
    ).toBeInTheDocument();

    const dispatchable = screen.getByRole('table');
    expect(within(dispatchable).queryByText('Cora Clark')).toBeNull();

    const changes = screen
      .getByRole('heading', { name: '1 that require a change somewhere else' })
      .closest('section') as HTMLElement;
    expect(within(changes).getByText(/Cora Clark/)).toBeInTheDocument();
    expect(
      within(changes).getByText(/a business rule grants this, and the rule has to change first/),
    ).toBeInTheDocument();
    // The partial-removal trap, named on the row. A reader not told which
    // attributions survive reads "removed".
    expect(within(changes).getByText(/Not removed: the rule/)).toBeInTheDocument();
  });
});
