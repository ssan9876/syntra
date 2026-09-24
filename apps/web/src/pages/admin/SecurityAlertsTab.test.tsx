import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityAlertsTab, parseAlertDays } from './SecurityAlertsTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const policy = {
  emailCategories: ['write_stops'],
  alertDays: [30, 14, 7, 1],
  categories: [
    {
      key: 'data_exports',
      label: 'Data exports',
      description: 'A bulk export of tenant data was requested.',
      actions: ['export.request'],
      emailEnabled: false,
    },
    {
      key: 'write_stops',
      label: 'Emergency write stops',
      description: 'A write stop was placed, resumed, or expired.',
      actions: ['provision.tenant.external_writes.pause'],
      emailEnabled: true,
    },
  ],
};

beforeEach(() => vi.restoreAllMocks());

describe('parseAlertDays', () => {
  it('accepts up to eight whole days, de-duplicated and most distant first', () => {
    expect(parseAlertDays('7, 30 14,7')).toEqual([30, 14, 7]);
    expect(parseAlertDays('0')).toBeNull();
    expect(parseAlertDays('1.5')).toBeNull();
    expect(parseAlertDays('')).toBeNull();
    expect(parseAlertDays('1 2 3 4 5 6 7 8 9')).toBeNull();
  });
});

describe('SecurityAlertsTab', () => {
  it('shows each category with the events behind it and what is currently mailed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(policy));
    render(<SecurityAlertsTab />);
    const exports = await screen.findByRole('checkbox', { name: 'Data exports' });
    expect(exports).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Emergency write stops' })).toBeChecked();
    expect(screen.getByText('export.request')).toBeVisible();
    expect(screen.getByLabelText('Warn this many days before expiry')).toHaveValue('30, 14, 7, 1');
  });

  it('saves the chosen categories and thresholds', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(policy))
      .mockResolvedValueOnce(json({ emailCategories: ['data_exports', 'write_stops'], alertDays: [60, 7] }))
      .mockResolvedValueOnce(json({ ...policy, emailCategories: ['data_exports', 'write_stops'], alertDays: [60, 7] }));
    render(<SecurityAlertsTab />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Data exports' }));
    const days = screen.getByLabelText('Warn this many days before expiry');
    await userEvent.clear(days);
    await userEvent.type(days, '7, 60');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[1]![1]!.method).toBe('PUT');
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({
      emailCategories: ['data_exports', 'write_stops'],
      alertDays: [60, 7],
    });
    expect(await screen.findByText('Security notification policy saved.')).toBeVisible();
  });

  it('refuses thresholds it cannot send', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(policy));
    render(<SecurityAlertsTab />);
    const days = await screen.findByLabelText('Warn this many days before expiry');
    await userEvent.clear(days);
    await userEvent.type(days, '400');
    expect(screen.getByText(/between 1 and 365/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  });
});
