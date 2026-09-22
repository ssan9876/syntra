import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmployeeMover } from './EmployeeMover.js';

beforeEach(() => vi.restoreAllMocks());

describe('EmployeeMover', () => {
  it('requires a fresh preview and applies the exact reviewed change', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      if (url.endsWith('/preview')) {
        return new Response(
          JSON.stringify({
            tenantId: '11111111-1111-4111-8111-111111111111',
            personId: '22222222-2222-4222-8222-222222222222',
            contractSequence: 1,
            revision: 'a'.repeat(64),
            requested: { department: 'Clinical Operations' },
            changes: [{ field: 'department', before: 'Finance', after: 'Clinical Operations' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const user = userEvent.setup();
    render(
      <EmployeeMover
        personId="22222222-2222-4222-8222-222222222222"
        contract={{ sequence: 1, department: 'Finance', jobTitle: 'Analyst', location: null }}
      />,
    );

    await user.clear(screen.getByLabelText('New department'));
    await user.type(screen.getByLabelText('New department'), 'Clinical Operations');
    await user.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByText(/Finance → Clinical Operations/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply reviewed change' }));
    expect(await screen.findByText('Employment change completed.')).toBeInTheDocument();
    expect(calls.map((call) => call.url)).toEqual([
      '/api/admin/persons/22222222-2222-4222-8222-222222222222/mover/preview',
      '/api/admin/persons/22222222-2222-4222-8222-222222222222/mover/apply',
    ]);
  });
});
