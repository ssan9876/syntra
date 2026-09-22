import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GuidedOnboardingPage } from './GuidedOnboardingPage.js';

beforeEach(() => vi.restoreAllMocks());

describe('GuidedOnboardingPage', () => {
  it('submits one durable operation and shows its resumable receipt', async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/admin/targets') {
        return new Response(JSON.stringify({ targets: [{ id: '11111111-1111-4111-8111-111111111111', name: 'AD', enabled: true }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        person: { id: '22222222-2222-4222-8222-222222222222', givenName: 'Maya', familyName: 'Okafor' },
        operation: { id: '33333333-3333-4333-8333-333333333333', status: 'waiting', steps: [{ key: 'local', title: 'Save employee, contract, and login', status: 'succeeded' }, { key: 'targets', title: 'Provision and verify target access', status: 'running' }] },
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    const user = userEvent.setup();
    render(<MemoryRouter><GuidedOnboardingPage /></MemoryRouter>);
    await user.type(screen.getByLabelText('Given name'), 'Maya');
    await user.type(screen.getByLabelText('Family name'), 'Okafor');
    await user.type(screen.getByLabelText('Start date'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Start onboarding' }));

    expect(await screen.findByText('Onboarding is waiting for target systems.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open employee' })).toHaveAttribute('href', '/admin/people/22222222-2222-4222-8222-222222222222');
    expect(bodies[0]).toMatchObject({ person: { givenName: 'Maya', familyName: 'Okafor' }, targetIds: ['11111111-1111-4111-8111-111111111111'] });
  });
});
