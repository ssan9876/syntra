import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('shows the current manager by name and sends the one picked from the directory search', async () => {
    const MAYA = '22222222-2222-4222-8222-222222222222';
    const OLD = '33333333-3333-4333-8333-333333333333';
    const NEW = '44444444-4444-4444-8444-444444444444';
    const requested: string[] = [];
    let previewBody: { changes?: { managerPersonId?: string | null } } = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      requested.push(url);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === `/api/admin/persons/${OLD}`) return reply({ id: OLD, givenName: 'Old', familyName: 'Boss' });
      if (url.startsWith('/api/admin/persons?')) {
        // The person being moved is filtered out: nobody manages themselves.
        return reply({ persons: [
          { id: NEW, givenName: 'New', familyName: 'Boss', businessEmail: 'new@acme.test' },
          { id: MAYA, givenName: 'Maya', familyName: 'Okafor' },
        ], total: 2 });
      }
      previewBody = JSON.parse(String(init?.body));
      return reply({ tenantId: 't', personId: MAYA, contractSequence: 1, revision: 'r', requested: {}, changes: [] });
    });
    const user = userEvent.setup();
    render(<EmployeeMover personId={MAYA} contract={{ sequence: 1, department: 'Finance', jobTitle: null, managerPersonId: OLD }} />);

    const picker = screen.getByRole('combobox', { name: 'New manager' });
    await waitFor(() => expect(picker).toHaveValue('Old Boss'));
    await user.clear(picker);
    await user.type(picker, 'boss');
    expect(await screen.findByRole('option', { name: /New Boss/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Maya Okafor/ })).toBeNull();
    expect(requested).toContain('/api/admin/persons?q=boss&pageSize=20');
    await user.click(screen.getByRole('option', { name: /New Boss/ }));
    await user.click(screen.getByRole('button', { name: 'Preview change' }));
    await waitFor(() => expect(previewBody.changes?.managerPersonId).toBe(NEW));
  });
});
