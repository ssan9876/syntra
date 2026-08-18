import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SweepDetailPage } from './SweepDetailPage.js';

const sweep = {
  id: 's1',
  status: 'previewed',
  requiresConfirmation: true,
  blockedReason:
    'Finance folder would lose 90 of its 90 holders (100.0%, threshold 50%)',
  expireCount: 90,
  lapseCount: 0,
  reviewFlagCount: 2,
  personsWithActiveContract: 1180,
  personsUnprocessable: 1,
  actions: [
    {
      id: 'a1',
      kind: 'expire',
      subjectPersonId: 'p1',
      resourceType: 'application',
      resourceId: 'app-1',
      productId: 'prod-1',
      status: 'proposed',
      message: 'the grant ended on 2026-06-01',
    },
  ],
  exceptions: [
    {
      id: 'x1',
      personId: 'p9',
      kind: 'no_contracts',
      message: 'this person holds no contract at all',
    },
  ],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockFetch(onApply?: (body: unknown) => void) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/apply')) {
      onApply?.(JSON.parse(String(init?.body ?? '{}')));
      return Promise.resolve(
        json({ status: 'applied', applied: 1, skipped: 0, failed: 0 }),
      );
    }
    return Promise.resolve(json(sweep));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/automate/sweeps/s1']}>
      <Routes>
        <Route
          path="/admin/automate/sweeps/:id"
          element={<SweepDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('SweepDetailPage', () => {
  it('leads with why it stopped and the numbers behind it', async () => {
    mockFetch();
    renderPage();
    expect(
      await screen.findByText(/would lose 90 of its 90 holders/),
    ).toBeInTheDocument();
  });

  it('names the people it could not understand, by person', async () => {
    // A count is not an answer. With people, the only useful question is
    // *which* one.
    mockFetch();
    renderPage();
    expect(
      await screen.findByText(/holds no contract at all/),
    ).toBeInTheDocument();
  });

  it('sends confirm true and only the rows that were left ticked', async () => {
    const sent: unknown[] = [];
    mockFetch((body) => sent.push(body));
    renderPage();
    await screen.findByText(/would lose 90 of its 90 holders/);
    await userEvent.click(screen.getByRole('checkbox', { name: /app-1/i }));
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(sent[0]).toEqual({ confirm: true, only: [] });
  });

  it('does not offer confirmation on a blocked sweep', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        json({ ...sweep, status: 'blocked', requiresConfirmation: false }),
      ),
    );
    renderPage();
    await screen.findByText(/would lose 90 of its 90 holders/);
    // A blocked sweep is one whose own inputs are not trustworthy. There is no
    // button, because there is nothing a human could usefully confirm.
    expect(
      screen.queryByRole('button', { name: /apply/i }),
    ).not.toBeInTheDocument();
  });
});
