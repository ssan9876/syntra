import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider } from '../../session/SessionProvider.js';
import { RequestFormPage } from './RequestFormPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockForm(form: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(json(form)));
}

const base = {
  name: 'AP approve',
  requestInstructions: null,
  formSchema: [],
  durationMode: 'permanent',
  defaultDurationDays: null,
  maxDurationDays: null,
  resources: [],
};

/** The page reads `:id` from the route, so it has to be mounted under one. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/catalog/p3']}>
      <SessionProvider>
        <Routes>
          <Route path="/catalog/:id" element={<RequestFormPage />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('RequestFormPage', () => {
  it('warns about segregation of duties and leaves the submit control ENABLED', async () => {
    // Spec section 14: the warning does not block submission. The refusal,
    // when there is one, happens at eligibility with a reason the requester
    // can read — a form that greyed this button out would tell somebody they
    // may not have something without ever telling them why.
    //
    // The enabled assertion is the load-bearing one. It is what stops a later
    // "improvement" from turning a warning into a block, which would be a
    // silent reversal of the design §14 chose deliberately.
    mockForm({
      ...base,
      sodWarning: {
        violations: [
          {
            ruleId: 'r1',
            ruleName: 'AP entry vs AP approve',
            severity: 'critical',
            otherSideHoldings: ['AP entry (Finance-Payments)'],
          },
        ],
        hasCritical: true,
        hasActiveException: false,
      },
    });
    renderPage();

    expect(await screen.findByText(/segregation of duties/i)).toBeInTheDocument();
    expect(screen.getByText(/AP entry vs AP approve/)).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: /send the request/i });
    expect(submit).toBeEnabled();
  });

  it('renders no warning when there is nothing to warn about', async () => {
    mockForm({ ...base, sodWarning: null });
    renderPage();
    await screen.findByRole('button', { name: /send the request/i });
    expect(screen.queryByText(/segregation of duties/i)).toBeNull();
  });
});
