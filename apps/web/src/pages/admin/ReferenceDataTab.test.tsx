import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReferenceDataTab } from './ReferenceDataTab.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

beforeEach(() => vi.restoreAllMocks());

describe('ReferenceDataTab', () => {
  it('makes opt-in enforcement visible for each catalog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      values: [{ id: 'd1', kind: 'department', value: 'Research', active: true }],
    }));
    render(<ReferenceDataTab />);

    expect(await screen.findByRole('heading', { name: 'Departments' })).toBeInTheDocument();
    expect(screen.getByText('Enforced on import')).toBeInTheDocument();
    expect(screen.getByText('Not enforced')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('adds a normalized catalog value and refreshes the list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ values: [] }))
      .mockResolvedValueOnce(response({ id: 'l1', kind: 'location', value: 'Phoenix', active: true }, 201))
      .mockResolvedValueOnce(response({ values: [{ id: 'l1', kind: 'location', value: 'Phoenix', active: true }] }));
    const user = userEvent.setup();
    render(<ReferenceDataTab />);

    await screen.findByText('No governed locations');
    await user.type(screen.getByLabelText('Add location'), 'Phoenix');
    await user.click(screen.getByRole('button', { name: 'Add location' }));

    expect(await screen.findByRole('rowheader', { name: 'Phoenix' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/identity-reference-values', expect.objectContaining({ method: 'POST' }));
  });
});
