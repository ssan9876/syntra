import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/** `mockForm`, plus the POST bodies, so a submit can be asserted on. */
function mockFormWithSubmit(form: Record<string, unknown>) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (init?.method === 'POST') {
      sent.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return Promise.resolve(json({ requestId: 'r-1' }));
    }
    return Promise.resolve(json(form));
  });
  return sent;
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

describe('an extension', () => {
  const renderExtending = () =>
    render(
      <MemoryRouter initialEntries={['/catalog/p3?replaces=g-77']}>
        <SessionProvider>
          <Routes>
            <Route path="/catalog/:id" element={<RequestFormPage />} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );

  /**
   * `Extend` linked to the plain request form and sent no `replacesGrantId`,
   * so an "extension" was a second parallel grant: two live rows for the same
   * resource, two expiry dates, and `fulfil.ts`'s replacement path -- which
   * exists and ends the old grant when the new one lands -- never ran.
   */
  it('carries the grant it replaces through to the request', async () => {
    const sent = mockFormWithSubmit({ ...base });
    renderExtending();
    await screen.findByText('AP approve');

    await userEvent.click(screen.getByRole('button', { name: 'Send the request' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({ productId: 'p3', replacesGrantId: 'g-77' });
  });

  /**
   * And it SAYS so. A form that silently ends an existing grant when this one
   * is approved is a form that surprises somebody.
   */
  it('says that the current access will be replaced', async () => {
    mockFormWithSubmit({ ...base });
    renderExtending();
    expect(
      await screen.findByText(/replaces the access you already hold/i),
    ).toBeInTheDocument();
  });

  it('sends null when nothing is being replaced', async () => {
    const sent = mockFormWithSubmit({ ...base });
    renderPage();
    await screen.findByText('AP approve');
    await userEvent.click(screen.getByRole('button', { name: 'Send the request' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({ replacesGrantId: null });
  });
});
