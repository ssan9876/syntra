import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EmployeeWorkPage } from './EmployeeWorkPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const lanes = { action: 1, waiting: 1, blocked: 1, overdue: 0 };

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('EmployeeWorkPage', () => {
  it('uses the server counts and filters the same returned work rows', async () => {
    const all = {
      counts: { onboarding: 1, offboarding: 1, failed: 1, total: 3 },
      lanes,
      items: [
        { id: 'a', kind: 'onboarding', personId: 'p1', personName: 'A Person', status: 'planning', summary: 'AD planning', updatedAt: '2026-09-20T00:00:00Z', lane: 'waiting' },
        { id: 'b', kind: 'offboarding', personId: 'p2', personName: 'B Person', status: 'incomplete', summary: '1 active sign-in', updatedAt: '2026-09-20T00:00:00Z', lane: 'action' },
        { id: 'c', kind: 'failed', personId: 'p3', personName: 'C Person', status: 'failed', summary: 'LDAP failed', updatedAt: '2026-09-20T00:00:00Z', lane: 'blocked' },
      ],
      total: 3, page: 1, pageSize: 50,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const body = String(input).includes('kind=offboarding')
        ? { ...all, items: [all.items[1]], total: 1 }
        : all;
      return Promise.resolve(json(body));
    });
    render(<MemoryRouter><EmployeeWorkPage /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'A Person' })).toHaveAttribute('href', '/admin/people/p1');
    expect(screen.getByRole('link', { name: 'B Person' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /^Offboarding/ }));
    expect(await screen.findByRole('button', { name: 'Remove filter Work: Offboarding' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'A Person' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'B Person' })).toBeVisible();
  });

  it('shows each lane with its count and links a lane to its filtered list', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(json({
        counts: { onboarding: 1, offboarding: 1, failed: 1, total: 3 },
        lanes: { action: 2, waiting: 5, blocked: 1, overdue: 0 },
        items: [], total: 0, page: 1, pageSize: 50,
      })),
    );
    render(<MemoryRouter><EmployeeWorkPage /></MemoryRouter>);
    const nav = await screen.findByRole('navigation', { name: 'Work lanes' });
    const blocked = within(nav).getByRole('link', { name: /Blocked/ });
    expect(blocked).toHaveAttribute('href', '/?lane=blocked');
    expect(within(nav).getByText('5')).toBeVisible();

    await userEvent.click(blocked);
    expect(fetch).toHaveBeenLastCalledWith('/api/admin/employee-work?lane=blocked', expect.anything());
    expect(await screen.findByText('Nothing matches these filters')).toBeVisible();
  });

  it('names the next step for each kind of item', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      counts: { onboarding: 0, offboarding: 1, failed: 0, total: 2 },
      lanes: { action: 2, waiting: 0, blocked: 0, overdue: 0 },
      items: [
        { id: 'departure:p2', kind: 'offboarding', personId: 'p2', personName: 'B Person', status: 'incomplete', summary: '1 active sign-in', updatedAt: '2026-09-20T00:00:00Z', lane: 'action' },
        { id: 'lifecycle:op1', kind: 'onboarding', lifecycleKind: 'onboard', personId: 'p3', personName: 'C Person', status: 'awaiting_approval', summary: 'Waiting', updatedAt: '2026-09-20T00:00:00Z', lane: 'action', approvalRequired: true, ownerName: 'Operator' },
      ],
      total: 2, page: 1, pageSize: 50,
    }) as never);
    render(<MemoryRouter><EmployeeWorkPage /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Finish departure for B Person' })).toHaveAttribute('href', '/admin/people/p2');
    expect(screen.getByRole('link', { name: 'Review approval for C Person' })).toHaveAttribute('href', '/admin/lifecycle-operations/op1');
    expect(screen.getByText('Operator')).toBeVisible();
  });

  it('saves the current filters as a named view and reopens it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(json({ counts: { onboarding: 0, offboarding: 0, failed: 0, total: 0 }, lanes, items: [], total: 0, page: 1, pageSize: 50 })),
    );
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/?lane=waiting&kind=onboarding']}><EmployeeWorkPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Save this view' }));
    await user.type(screen.getByLabelText('View name'), 'Morning list');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const view = screen.getByRole('button', { name: 'Morning list' });
    expect(view).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(localStorage.getItem('syntra.employee-work.views.anonymous') ?? '[]')).toEqual([
      { name: 'Morning list', query: 'kind=onboarding&lane=waiting' },
    ]);

    await user.click(screen.getByRole('button', { name: 'All unresolved' }));
    expect(screen.getByRole('button', { name: 'Morning list' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('supports keyboard selection and a bulk acknowledgement for lifecycle work', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockImplementation((input) =>
      Promise.resolve(
        String(input).includes('/bulk')
          ? json({ approvalRequired: false, results: [{ operationId: 'x', ok: true }], succeeded: 1, failed: 0 })
          : json({
              counts: { onboarding: 1, offboarding: 0, failed: 0, total: 1 },
              lanes: { action: 0, waiting: 1, blocked: 0, overdue: 0 },
              items: [{ id: 'lifecycle:11111111-1111-4111-8111-111111111111', kind: 'onboarding', lifecycleKind: 'move', personId: 'p1', personName: 'A Person', status: 'waiting', summary: 'Awaiting verification', updatedAt: '2026-09-20T00:00:00Z', lane: 'waiting' }],
              total: 1, page: 1, pageSize: 50,
            }),
      ),
    );
    const user = userEvent.setup();
    render(<MemoryRouter><EmployeeWorkPage /></MemoryRouter>);
    const checkbox = await screen.findByRole('checkbox', { name: 'Select A Person lifecycle operation' });
    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();
    expect(screen.getByText('1 lifecycle operation selected')).toBeVisible();
    const acknowledge = screen.getByRole('button', { name: 'Acknowledge selected' });
    expect(acknowledge).toBeEnabled();
    await user.click(acknowledge);
    expect(fetch).toHaveBeenCalledWith('/api/admin/lifecycle-operations/bulk', expect.objectContaining({ method: 'POST' }));
    expect(await screen.findByText(/1 acknowledged/)).toBeVisible();
  });
});
