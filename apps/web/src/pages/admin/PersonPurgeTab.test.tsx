import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const granted = new Set<string>();
vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const { PersonPurgeTab } = await import('./PersonPurgeTab.js');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
});

describe('PersonPurgeTab', () => {
  it('shows the policy read-only without the Data deletion role', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ afterDays: 30 }));
    render(<PersonPurgeTab />);
    const field = await screen.findByLabelText('Days after leaving');
    expect(field).toHaveValue('30');
    expect(field).toBeDisabled();
    expect(screen.getByText('Only a holder of the Data deletion role can change this.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('saves a new number of days for a holder of person.purge', async () => {
    granted.add('person.purge');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ afterDays: null }))
      .mockResolvedValueOnce(json({ afterDays: 30 }))
      .mockResolvedValueOnce(json({ afterDays: 30 }));
    render(<PersonPurgeTab />);
    await userEvent.type(await screen.findByLabelText('Days after leaving'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe('/api/admin/person-purge-policy');
    expect(JSON.parse(String(init?.body))).toEqual({ afterDays: 30 });
    expect(await screen.findByText('People are deleted 30 days after they leave.')).toBeVisible();
  });

  it('refuses a value out of range before sending it', async () => {
    granted.add('person.purge');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ afterDays: null }));
    render(<PersonPurgeTab />);
    await userEvent.type(await screen.findByLabelText('Days after leaving'), '0');
    expect(screen.getByText('A whole number from 1 to 3650, or empty for never')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
