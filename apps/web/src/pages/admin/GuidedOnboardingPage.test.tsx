import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GuidedOnboardingPage } from './GuidedOnboardingPage.js';

beforeEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TARGET = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';

function serve(bodies: unknown[], requested: string[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requested.push(url);
    if (url === '/api/admin/targets') return json({ targets: [{ id: TARGET, name: 'AD', enabled: true }] });
    if (url.startsWith('/api/admin/persons?')) {
      return json({ persons: [{ id: '33333333-3333-4333-8333-333333333333', givenName: 'Sam', familyName: 'Taylor', businessEmail: 'sam@acme.test' }], total: 1 });
    }
    if (url === `/api/admin/persons/${PERSON}/provision-receipts`) {
      return json({ receipts: [{ id: 'rc1', targetSystemId: TARGET, targetName: 'AD', status: 'verification_pending', runId: 'run1', runIds: ['run1'], message: null, createdAt: '2026-09-24T00:00:00Z' }] });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return json({
      person: { id: PERSON, givenName: 'Maya', familyName: 'Okafor' },
      operation: { id: '44444444-4444-4444-8444-444444444444', status: 'waiting', steps: [{ key: 'local', title: 'Save employee, contract, and login', status: 'succeeded' }, { key: 'targets', title: 'Provision and verify target access', status: 'running' }] },
    }, 201);
  });
}

describe('GuidedOnboardingPage', () => {
  it('submits one durable operation and shows a receipt that separates applied from observed', async () => {
    const bodies: unknown[] = [];
    serve(bodies);
    const user = userEvent.setup();
    render(<MemoryRouter><GuidedOnboardingPage /></MemoryRouter>);
    await user.type(screen.getByLabelText('Given name'), 'Maya');
    await user.type(screen.getByLabelText('Family name'), 'Okafor');
    await user.type(screen.getByLabelText('Start date'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Start onboarding' }));

    expect(await screen.findByText('Waiting for targets')).toBeInTheDocument();
    const receipt = screen.getByRole('table', { name: 'Onboarding receipt' });
    // Written to AD and not yet read back: applied, never "observed".
    const row = (await within(receipt).findByText('AD')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Applied, awaiting read-back')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open employee' })).toHaveAttribute('href', `/admin/people/${PERSON}`);
    expect(bodies[0]).toMatchObject({ person: { givenName: 'Maya', familyName: 'Okafor' }, targetIds: [TARGET] });
  });

  it('names every missing required field instead of sending the request', async () => {
    const bodies: unknown[] = [];
    serve(bodies);
    const user = userEvent.setup();
    render(<MemoryRouter><GuidedOnboardingPage /></MemoryRouter>);
    await screen.findByText('AD');
    await user.click(screen.getByRole('button', { name: 'Start onboarding' }));

    const summary = await screen.findByRole('alert');
    expect(within(summary).getByRole('button', { name: 'Enter a given name' })).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: 'Enter a start date' })).toBeInTheDocument();
    expect(screen.getByLabelText('Family name')).toBeRequired();
    expect(bodies).toEqual([]);
  });

  it('finds a manager through the server-backed person search', async () => {
    const bodies: unknown[] = [];
    const requested: string[] = [];
    serve(bodies, requested);
    const user = userEvent.setup();
    render(<MemoryRouter><GuidedOnboardingPage /></MemoryRouter>);
    await user.type(screen.getByLabelText('Given name'), 'Maya');
    await user.type(screen.getByLabelText('Family name'), 'Okafor');
    await user.type(screen.getByLabelText('Start date'), '2026-10-01');
    await user.type(screen.getByRole('combobox', { name: 'Manager' }), 'tay');
    await user.click(await screen.findByRole('option', { name: /Sam Taylor/ }));
    expect(requested).toContain('/api/admin/persons?q=tay&pageSize=20');

    await user.click(screen.getByRole('button', { name: 'Start onboarding' }));
    await screen.findByText('Waiting for targets');
    expect(bodies[0]).toMatchObject({ contract: { managerPersonId: '33333333-3333-4333-8333-333333333333' } });
  });
});
