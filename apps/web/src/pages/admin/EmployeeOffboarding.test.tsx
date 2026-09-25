import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EmployeeOffboarding } from './EmployeeOffboarding.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as never;
beforeEach(() => vi.restoreAllMocks());

describe('EmployeeOffboarding', () => {
  it('previews all linked access and reports partial account failure honestly', async () => {
    const changed = vi.fn();
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return json({ operationId: '00000000-0000-4000-8000-000000000001', results: [
          { userId: 'u1', login: 'maya', status: 'disabled', message: 'Sessions revoked.' },
          { userId: 'u2', login: 'maya-ad', status: 'failed', message: 'Directory unavailable.' },
        ] });
      }
      return json({
        revision: 'a'.repeat(64),
        accounts: [
          { id: 'u1', login: 'maya', status: 'active', source: null },
          { id: 'u2', login: 'maya-ad', status: 'active', source: { name: 'AD', writebackEnabled: true, writebackDisable: true } },
        ],
        targets: [{ id: 'ta1', status: 'active', correlationKey: 'maya', disableDueAt: null, archiveDueAt: null, target: { name: 'AD', enabled: true, disableGraceDays: 1, entitlementRevocationDelayDays: 0, archiveAfterDays: 30 } }],
        latestAttempt: null,
      });
    }) as never);
    render(<MemoryRouter><EmployeeOffboarding personId="p1" personName="Maya Okafor" onChanged={changed} /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: 'End employment' }));
    const target = await screen.findByRole('row', { name: /AD Active 1 day/ });
    expect(within(target).getByText('After 30 days')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Reason'), 'Employment ended');
    await userEvent.click(screen.getByRole('button', { name: 'End employment now' }));
    const failed = await screen.findByRole('row', { name: /maya-ad/ });
    expect(within(failed).getByText('Failed')).toBeVisible();
    expect(within(failed).getByText('Directory unavailable.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open offboarding operation' })).toHaveAttribute('href', '/admin/lifecycle-operations/00000000-0000-4000-8000-000000000001');
    expect(bodies).toEqual([{ reason: 'Employment ended', revision: 'a'.repeat(64), urgent: false }]);
    expect(changed).toHaveBeenCalledOnce();
  });
});
