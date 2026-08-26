import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyReviewsPage } from './MyReviewsPage.js';

const campaign = {
  id: 'c-1',
  name: 'H2 access review',
  dueAt: '2026-09-30T00:00:00.000Z',
  allowBulkCertify: true,
};

/**
 * One item per SUBJECT, deliberately.
 *
 * The page groups by subject, so a unique `subjectName` per item makes each
 * item its own panel and lets every assertion below be scoped to one item
 * rather than to the page. An assertion that a checkbox is missing is worth
 * nothing if it is really asserting that the page rendered no checkboxes at
 * all.
 */
const items = [
  {
    id: 'i-privileged',
    subjectKey: 'person:p-1',
    subjectName: 'Anna Admin',
    resourceKind: 'targetEntitlement',
    resourceName: 'Domain Admins',
    systemName: 'Acme AD',
    provenance: 'Granted by the rule “Platform team gets domain admin”, on 3 March 2026.',
    observedAt: '2026-08-01T00:00:00.000Z',
    observedVia: 'a directory read',
    lastCertifiedAt: null,
    lastCertifiedBy: null,
    coverageStatus: 'complete',
    sourceAgeHours: 2,
    sourceSlaHours: 24,
    riskFlags: ['privileged'],
    campaign,
  },
  {
    id: 'i-ordinary',
    subjectKey: 'person:p-2',
    subjectName: 'Ben Baker',
    resourceKind: 'targetEntitlement',
    resourceName: 'Ledger reader',
    systemName: 'Acme Finance',
    provenance: 'Requested by Ben Baker and approved by Dana Director, on 12 May 2026.',
    observedAt: '2026-08-01T00:00:00.000Z',
    observedVia: 'a directory read',
    lastCertifiedAt: '2026-02-01T00:00:00.000Z',
    lastCertifiedBy: 'Dana Director',
    coverageStatus: 'complete',
    sourceAgeHours: 2,
    sourceSlaHours: 24,
    riskFlags: [],
    campaign,
  },
  {
    id: 'i-partial',
    subjectKey: 'person:p-3',
    subjectName: 'Cora Clark',
    resourceKind: 'targetEntitlement',
    resourceName: 'Payments approver',
    systemName: 'Acme Payments',
    provenance: 'Assigned by hand in Syntra by Dana Director, on 9 June 2026.',
    observedAt: '2026-08-01T00:00:00.000Z',
    observedVia: 'a directory read',
    lastCertifiedAt: null,
    lastCertifiedBy: null,
    coverageStatus: 'partial',
    sourceAgeHours: 96.4,
    sourceSlaHours: 24,
    riskFlags: [],
    campaign,
  },
];

const panelFor = async (subject: string): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { name: subject });
  return heading.closest('section') as HTMLElement;
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 })),
  );
});

describe('MyReviewsPage', () => {
  it('carves a high-risk item out IN WORDS, and takes its bulk checkbox away', async () => {
    render(<MyReviewsPage />);

    const privileged = await panelFor('Anna Admin');
    // A SENTENCE. A disabled checkbox with no explanation teaches a reviewer
    // that the product is broken; this tells them which rule took the shortcut
    // away and why.
    expect(
      within(privileged).getByText(
        /has to be decided on its own, with a comment, because this is privileged access/,
      ),
    ).toBeInTheDocument();
    expect(within(privileged).queryByLabelText('include in bulk')).toBeNull();

    // The control exists on this page — it is this ITEM that does not get it.
    const ordinary = await panelFor('Ben Baker');
    expect(within(ordinary).getByLabelText('include in bulk')).toBeInTheDocument();
  });

  it('tells a reviewer the age of the data AND the SLA it breached, before they decide', async () => {
    render(<MyReviewsPage />);

    const partial = await panelFor('Cora Clark');
    const banner = within(partial).getByText(/was last read/);
    // Both numbers, on the item. "This data may be stale" is not something a
    // reviewer can weigh; "96 hours against a 24-hour SLA" is.
    expect(banner.textContent).toContain('96 hours ago');
    expect(banner.textContent).toContain('24-hour SLA');

    const complete = await panelFor('Ben Baker');
    expect(within(complete).queryByText(/was last read/)).toBeNull();
  });

  it('renders the provenance SENTENCE, never the attribution kind behind it', async () => {
    render(<MyReviewsPage />);

    const ordinary = await panelFor('Ben Baker');
    expect(
      within(ordinary).getByText(
        'Requested by Ben Baker and approved by Dana Director, on 12 May 2026.',
      ),
    ).toBeInTheDocument();

    // `business_rule` and `direct_assignment` are the vocabulary of the
    // attribution model, and a reviewer shown either of them has been shown a
    // database column. The answer to a row like that is "keep", every time.
    expect(document.body.textContent).not.toMatch(/business_rule|direct_assignment/);
  });
});

const otherCampaign = {
  id: 'c-2',
  name: 'Finance quarterly',
  dueAt: '2026-10-31T00:00:00.000Z',
  allowBulkCertify: true,
};

const acrossTwoCampaigns = [
  { ...items[1]!, id: 'i-first', campaign },
  { ...items[1]!, id: 'i-second', subjectName: 'Dee Dunn', campaign: otherCampaign },
];

/**
 * The file's fetch stub, grown enough to record what was sent.
 *
 * One mocking style per file: this extends the `vi.stubGlobal('fetch', ...)`
 * already in `beforeEach` rather than introducing a second convention beside
 * it.
 */
function mockReviews(
  rows: unknown[],
  opts: {
    bulkResult?: { certified: number; refused: { itemId: string; reason: string }[] };
    slowDecide?: boolean;
  } = {},
) {
  const sent: {
    bulk: { campaignId: string; itemIds: string[] }[];
    decisions: string[];
  } = { bulk: [], decisions: [] };

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (url.includes('/bulk-certify')) {
        sent.bulk.push(JSON.parse(String(init!.body)));
        return json(opts.bulkResult ?? { certified: 1, refused: [] });
      }
      if (url.includes('/decide')) {
        sent.decisions.push(url);
        // Never settles, so the second click lands while the first is still
        // in flight -- which is the whole of what the guard has to survive.
        if (opts.slowDecide) return new Promise<Response>(() => {});
        return json({ ok: true });
      }
      return json({ items: rows });
    }),
  );
  return sent;
}

describe('a selection spanning two campaigns', () => {
  /**
   * THE ONE THAT MATTERS. The list spans every open campaign, any bulk-enabled
   * item gets a checkbox, and the request always carried `items[0].campaign.id`
   * -- so `bulkCertify` filtered the other campaign's ids out, they were
   * neither certified nor listed in `refused`, the selection cleared, and
   * nothing anywhere said so. The reviewer believed they had certified twelve
   * items and had certified five.
   */
  it('sends one request per campaign, so nothing is dropped', async () => {
    const sent = mockReviews(acrossTwoCampaigns);
    render(<MyReviewsPage />);
    await screen.findByText('Ben Baker');

    for (const box of screen.getAllByLabelText('include in bulk')) {
      await userEvent.click(box);
    }
    await userEvent.click(screen.getByRole('button', { name: /Certify selected/ }));

    await waitFor(() => expect(sent.bulk).toHaveLength(2));
    expect(sent.bulk.map((b) => b.campaignId).sort()).toEqual(['c-1', 'c-2']);
    expect(sent.bulk.flatMap((b) => b.itemIds).sort()).toEqual(['i-first', 'i-second']);
  });

  /** And every refusal from every request reaches the screen. */
  it('reports refusals from all of them', async () => {
    mockReviews(acrossTwoCampaigns, {
      bulkResult: {
        certified: 0,
        refused: [{ itemId: 'x', reason: 'this item is already certified' }],
      },
    });
    render(<MyReviewsPage />);
    await screen.findByText('Ben Baker');

    for (const box of screen.getAllByLabelText('include in bulk')) {
      await userEvent.click(box);
    }
    await userEvent.click(screen.getByRole('button', { name: /Certify selected/ }));

    expect(await screen.findByText(/2 item\(s\) were not certified/)).toBeInTheDocument();
  });

  /**
   * The button rendered on `items[0].campaign.allowBulkCertify`, so a reviewer
   * whose first item happened to belong to a campaign without bulk certify had
   * no button at all -- for a queue that was mostly bulk-enabled.
   */
  it('offers the button when ANY item allows it, not only the first', async () => {
    mockReviews([
      { ...items[0]!, campaign: { ...campaign, allowBulkCertify: false } },
      { ...items[1]!, campaign: otherCampaign },
    ]);
    render(<MyReviewsPage />);
    await screen.findByText('Ben Baker');
    expect(screen.getByRole('button', { name: /Certify selected/ })).toBeInTheDocument();
  });
});

describe('a double-click', () => {
  /**
   * A revoke is a removal. Two of them for one item is two decisions in the
   * audit trail and, under `quorum: 'any'`, a second decision the state
   * machine has to reconcile.
   */
  it('does not submit a decision twice', async () => {
    const sent = mockReviews([items[1]!], { slowDecide: true });
    render(<MyReviewsPage />);
    await screen.findByText('Ben Baker');

    const keep = screen.getByRole('button', { name: 'Keep' });
    await userEvent.click(keep);
    expect(keep).toBeDisabled();
    await userEvent.click(keep);

    await waitFor(() => expect(sent.decisions).toHaveLength(1));
  });
});
