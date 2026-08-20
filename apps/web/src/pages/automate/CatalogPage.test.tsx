import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
// `AppShell`, which every portal page renders, calls `useSession`, so a page
// mounted without the provider throws before it renders anything. The plan's
// fixture omitted it and all six cases died on the same line.
import { SessionProvider } from '../../session/SessionProvider.js';
import { CatalogPage } from './CatalogPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockCatalog(products: Record<string, unknown>[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(json({ products })),
  );
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <CatalogPage />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('CatalogPage', () => {
  it('says plainly when a product is granted immediately', async () => {
    // The catalog shows such a product as "granted immediately" so the
    // requester knows BEFORE they ask.
    mockCatalog([
      {
        id: 'p1',
        name: 'Reading room',
        slug: 'reading-room',
        description: null,
        category: null,
        kind: 'application',
        durationMode: 'permanent',
        maxDurationDays: null,
        needsApproval: false,
      },
    ]);
    renderPage();
    expect(await screen.findByText(/granted immediately/i)).toBeInTheDocument();
  });

  it('says how long a time-bounded product runs for', async () => {
    mockCatalog([
      {
        id: 'p2',
        name: 'Finance folder',
        slug: 'finance-folder',
        description: null,
        category: 'Finance',
        kind: 'targetEntitlement',
        durationMode: 'requesterChoice',
        maxDurationDays: 90,
        needsApproval: true,
      },
    ]);
    renderPage();
    expect(await screen.findByText(/up to 90 days/i)).toBeInTheDocument();
  });

  it('warns about segregation of duties on the card WITHOUT hiding the way in', async () => {
    // Spec section 14 wants the warning at REQUEST time, not only at approval
    // time — this is the only moment at which it changes anything, because it
    // is the only moment at which the requester could still choose
    // differently.
    mockCatalog([
      {
        id: 'p3',
        name: 'AP approve',
        slug: 'ap-approve',
        description: null,
        category: null,
        kind: 'targetEntitlement',
        durationMode: 'permanent',
        maxDurationDays: null,
        needsApproval: true,
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
      },
    ]);
    renderPage();
    expect(await screen.findByText(/segregation of duties/i)).toBeInTheDocument();
    // Naming the rule and the holding on the other side is what makes it
    // actionable. "You would violate a rule" is not.
    expect(
      screen.getByText(/AP entry vs AP approve/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/AP entry \(Finance-Payments\)/),
    ).toBeInTheDocument();

    // AND the way into the request form is untouched. A catalog that greyed
    // the entry out would tell somebody they may not have something without
    // telling them why, which is the failure section 14 names — this
    // assertion is what stops a later "improvement" turning the warning into a
    // block.
    const link = screen.getByRole('link', { name: 'AP approve' });
    expect(link).toHaveAttribute('href', '/catalog/p3');
    expect(link).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('renders no warning at all when there is nothing to warn about', async () => {
    // The common case. A card decorated with an empty warning trains people to
    // scroll past the one that matters.
    mockCatalog([
      {
        id: 'p4',
        name: 'Reading room',
        slug: 'reading-room',
        description: null,
        category: null,
        kind: 'application',
        durationMode: 'permanent',
        maxDurationDays: null,
        needsApproval: false,
        sodWarning: null,
      },
    ]);
    renderPage();
    await screen.findByText(/granted immediately/i);
    expect(screen.queryByText(/segregation of duties/i)).toBeNull();
  });

  it('shows an empty catalog as a fact rather than an error', async () => {
    // An empty catalog is what a correctly-configured tenant looks like on day
    // one, and it is what a person outside every audience sees. Neither is a
    // failure, and saying "something went wrong" would send them to support.
    mockCatalog([]);
    renderPage();
    expect(
      await screen.findByText(/nothing to ask for yet/i),
    ).toBeInTheDocument();
  });
});
