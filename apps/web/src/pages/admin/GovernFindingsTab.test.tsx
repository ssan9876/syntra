import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    await waitFor(() => expect(screen.getByText(/Build a snapshot/i)).toBeInTheDocument());
  });
});
