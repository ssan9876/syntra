import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EmployeeWorkPage } from './EmployeeWorkPage.js';

beforeEach(() => vi.restoreAllMocks());
describe('EmployeeWorkPage', () => {
  it('uses the server counts and filters the same returned work rows', async () => {
    const all = {
      counts: { onboarding: 1, offboarding: 1, failed: 1, total: 3 },
      items: [
        { id: 'a', kind: 'onboarding', personId: 'p1', personName: 'A Person', status: 'planning', summary: 'AD planning', updatedAt: '2026-09-20T00:00:00Z' },
        { id: 'b', kind: 'offboarding', personId: 'p2', personName: 'B Person', status: 'incomplete', summary: '1 active sign-in', updatedAt: '2026-09-20T00:00:00Z' },
        { id: 'c', kind: 'failed', personId: 'p3', personName: 'C Person', status: 'failed', summary: 'LDAP failed', updatedAt: '2026-09-20T00:00:00Z' },
      ],
      total: 3, page: 1, pageSize: 50,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const body = String(input).includes('kind=offboarding')
        ? { ...all, items: [all.items[1]], total: 1 }
        : all;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    render(<MemoryRouter><EmployeeWorkPage /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'A Person' })).toHaveAttribute('href', '/admin/people/p1');
    expect(screen.getByRole('link', { name: 'B Person' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Show offboarding work' }));
    expect(screen.queryByRole('link', { name: 'A Person' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'B Person' })).toBeVisible();
  });

  it('supports keyboard selection and a bulk acknowledgement for lifecycle work', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValue(new Response(JSON.stringify({
      counts: { onboarding: 1, offboarding: 0, failed: 0, total: 1 },
      items: [{ id: 'lifecycle:11111111-1111-4111-8111-111111111111', kind: 'onboarding', lifecycleKind: 'move', personId: 'p1', personName: 'A Person', status: 'waiting', summary: 'Awaiting verification', updatedAt: '2026-09-20T00:00:00Z' }],
      total: 1, page: 1, pageSize: 50,
    }), { status: 200, headers: { 'content-type': 'application/json' } }) as never);
    const user = userEvent.setup();
    render(<MemoryRouter><EmployeeWorkPage /></MemoryRouter>);
    const checkbox = await screen.findByRole('checkbox', { name: 'Select A Person lifecycle operation' });
    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();
    const acknowledge = screen.getByRole('button', { name: 'Acknowledge selected' });
    expect(acknowledge).toBeEnabled();
    await user.click(acknowledge);
    expect(fetch).toHaveBeenCalledWith('/api/admin/lifecycle-operations/bulk', expect.objectContaining({ method: 'POST' }));
  });
});
