import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequestQueuePage } from './RequestQueuePage.js';

const requests = [
  {
    id: 'r-ok',
    status: 'pending_approval',
    submittedAt: '2026-06-14T09:00:00.000Z',
    subjectPersonId: 'p1',
    statusReason: null,
    product: { name: 'Statistics licence' },
    items: [],
  },
  {
    id: 'r-blocked',
    status: 'blocked_no_approver',
    submittedAt: '2026-06-10T09:00:00.000Z',
    subjectPersonId: 'p2',
    statusReason: 'stage 1 resolved to nobody',
    product: { name: 'Finance folder' },
    items: [],
  },
  {
    id: 'r-failed',
    status: 'fulfilment_failed',
    submittedAt: '2026-06-11T09:00:00.000Z',
    subjectPersonId: 'p3',
    statusReason: null,
    product: { name: 'Mailbox' },
    items: [
      {
        status: 'failed',
        message: 'WILL_NOT_PERFORM: 0x2082',
        resourceId: 'e1',
      },
    ],
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(json({ requests })),
  );
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <RequestQueuePage />
    </MemoryRouter>,
  );

describe('RequestQueuePage', () => {
  it('leads with the ones that are stuck, whatever their age', async () => {
    // Blocked and failed first, then everything else. A queue ordered only by
    // date buries the two states that need a human.
    renderPage();
    const rows = await screen.findAllByRole('row');
    const text = rows.map((row) => row.textContent ?? '');
    const blocked = text.findIndex((t) => t.includes('Finance folder'));
    const failed = text.findIndex((t) => t.includes('Mailbox'));
    const ordinary = text.findIndex((t) => t.includes('Statistics licence'));
    expect(blocked).toBeLessThan(ordinary);
    expect(failed).toBeLessThan(ordinary);
  });

  it('shows the target own message on a failed fulfilment', async () => {
    // The message is the only thing that tells an administrator what to fix.
    renderPage();
    expect(await screen.findByText(/WILL_NOT_PERFORM/)).toBeInTheDocument();
  });

  it('renders blocked in the danger tone', async () => {
    renderPage();
    expect(
      await screen.findByText(/nobody can approve this/i),
    ).toBeInTheDocument();
  });
});
