import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
// `AppShell`, which every portal page renders, calls `useSession`, so a page
// mounted without the provider throws before it renders anything. The plan's
// fixture omitted it and all six cases died on the same line.
import { SessionProvider } from '../../session/SessionProvider.js';
import { MyApprovalsPage } from './MyApprovalsPage.js';

const approvals = [
  {
    id: 'step-1',
    requestId: 'req-1',
    sequence: 1,
    openedAt: '2026-06-14T09:00:00.000Z',
    request: {
      id: 'req-1',
      subjectPersonId: 'person-1',
      justification: 'Q3 audit',
      requestedDurationDays: 30,
      product: { name: 'Statistics licence' },
      items: [{ resourceType: 'application', resourceId: 'app-1' }],
    },
  },
];

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockFetch(onDecide?: (body: unknown) => Response) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/decide')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return Promise.resolve(
        (onDecide?.(body) ?? json({ status: 'fulfilled' })) as never,
      );
    }
    return Promise.resolve(json({ approvals }));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <MyApprovalsPage />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('MyApprovalsPage', () => {
  it('shows the justification, because an approver deciding without one decides badly', async () => {
    mockFetch();
    renderPage();
    expect(await screen.findByText('Q3 audit')).toBeInTheDocument();
  });

  it('will not send a rejection without a comment', async () => {
    // The server refuses it too. This is the half that tells the approver
    // before they have typed nothing and pressed a button twice.
    const sent: unknown[] = [];
    mockFetch((body) => {
      sent.push(body);
      return json({ status: 'rejected' });
    });
    renderPage();
    await screen.findByText('Q3 audit');
    await userEvent.click(screen.getByRole('button', { name: /refuse/i }));
    expect(sent).toEqual([]);
    expect(screen.getByText(/say why/i)).toBeInTheDocument();
  });

  it('sends the shortened duration when the approver shortens it', async () => {
    const sent: Record<string, unknown>[] = [];
    mockFetch((body) => {
      sent.push(body as Record<string, unknown>);
      return json({ status: 'fulfilled' });
    });
    renderPage();
    await screen.findByText('Q3 audit');
    await userEvent.clear(screen.getByLabelText(/shorten to/i));
    await userEvent.type(screen.getByLabelText(/shorten to/i), '7');
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(sent[0]).toMatchObject({ decision: 'approve', shortenedToDays: 7 });
  });
});
