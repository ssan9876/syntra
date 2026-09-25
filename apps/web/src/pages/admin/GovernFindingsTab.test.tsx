import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GovernFindingsTab } from './GovernFindingsTab.js';

const findings = [
  {
    id: 'f-1',
    kind: 'unattributable_holding',
    severity: 'critical',
    status: 'open',
    subjectRefType: 'holding',
    subjectRefId: 'person:p-1|sys-1|targetEntitlement|ent-1',
    detail: { resourceName: 'Domain Admins', systemName: 'Acme AD', privileged: true },
    firstSeenAt: '2026-06-01T00:00:00.000Z',
    lastSeenAt: '2026-06-15T00:00:00.000Z',
    ownerPersonId: null,
    dueAt: null,
  },
  {
    id: 'f-2',
    kind: 'access_without_contract',
    severity: 'high',
    status: 'open',
    subjectRefType: 'person',
    subjectRefId: 'p-9',
    detail: { holdingCount: 4, hasAnyContractRecord: true },
    firstSeenAt: '2026-06-10T00:00:00.000Z',
    lastSeenAt: '2026-06-15T00:00:00.000Z',
    ownerPersonId: null,
    dueAt: null,
  },
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ findings }), { status: 200 })),
  );
});

describe('GovernFindingsTab', () => {
  it('leads with the uncomfortable findings, not with a certification rate', async () => {
    render(
      <MemoryRouter>
        <GovernFindingsTab />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Domain Admins/)).toBeInTheDocument());

    const rows = screen.getAllByRole('row').slice(1);
    // The first row is the thing nobody can explain. A page sorted
    // alphabetically would put `access_without_contract` first.
    expect(rows[0]!.textContent).toContain('Nothing in Syntra explains this access');
    expect(screen.queryByText(/% certified/)).not.toBeInTheDocument();
  });

  it('renders each kind in plain language rather than as its enum value', async () => {
    render(
      <MemoryRouter>
        <GovernFindingsTab />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText(/holds access with no active contract/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('access_without_contract')).not.toBeInTheDocument();
  });

  it('shows an empty state that names the next action, not the absence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ findings: [] }), { status: 200 })),
    );
    render(
      <MemoryRouter>
        <GovernFindingsTab />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Build a snapshot' })).toHaveAttribute(
        'href',
        '/admin/govern?tab=snapshots',
      ),
    );
  });

  it('says an empty filter is a filter, and offers the way back to the open queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({ findings: String(input).includes('status=accepted') ? [] : findings }),
          { status: 200 },
        ),
      ),
    );
    render(
      <MemoryRouter>
        <GovernFindingsTab />
      </MemoryRouter>,
    );
    await screen.findByText(/Domain Admins/);

    await userEvent.click(screen.getByRole('button', { name: 'Accepted' }));
    expect(await screen.findByText('No accepted findings')).toBeInTheDocument();
    // Not the day-one empty state: nothing here says to build a snapshot.
    expect(screen.queryByRole('link', { name: 'Build a snapshot' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show open findings' }));
    expect(await screen.findByText(/Domain Admins/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'true');
  });
});
