import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TenantWriteStopPanel } from './TenantWriteStopPanel.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const allowed = {
  active: false, pausedAt: null, pausedByUserId: null, pauseReason: null,
  pauseExpiresAt: null, resumedAt: null, resumedByUserId: null,
};

afterEach(() => vi.restoreAllMocks());

describe('TenantWriteStopPanel', () => {
  it('places a tenant-wide stop with a reason and optional expiry, then rereads the state', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(allowed))
      .mockResolvedValueOnce(json({ ...allowed, active: true }))
      .mockResolvedValueOnce(json({ ...allowed, active: true, pausedAt: '2026-09-23T12:00:00Z', pauseReason: 'Bad HR feed' }));
    render(<TenantWriteStopPanel />);
    const button = await screen.findByRole('button', { name: 'Stop external writes' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason for stopping writes'), 'Bad HR feed');
    await userEvent.click(button);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(String(fetch.mock.calls[1]?.[0])).toBe('/api/admin/provision/external-write-stop');
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ reason: 'Bad HR feed', expiresAt: null });
    expect(await screen.findByText('All provisioning writes are stopped for every target in this tenant')).toBeVisible();
  });

  it('shows an active stop conspicuously and requires a reviewed resume', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      ...allowed, active: true, pausedAt: '2026-09-23T12:00:00Z', pausedByUserId: 'user-1',
      pauseReason: 'Suspected compromised administrator', pauseExpiresAt: null,
    }));
    render(<TenantWriteStopPanel />);
    expect(await screen.findByText('All provisioning writes are stopped for every target in this tenant')).toBeVisible();
    expect(screen.getByText(/Suspected compromised administrator/)).toBeVisible();
    expect(screen.getByText(/no automatic expiry/)).toBeVisible();
    expect(screen.getByText('paused')).toBeVisible();
    expect(screen.getByText(/different administrator must approve/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Request reviewed resume' })).toBeDisabled();
  });

  it('treats a lapsed expiry as allowed, matching the server', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      ...allowed, active: true, pausedAt: '2020-01-01T00:00:00Z', pausedByUserId: 'user-1',
      pauseReason: 'Old hold', pauseExpiresAt: '2020-01-02T00:00:00Z',
    }));
    render(<TenantWriteStopPanel />);
    expect(await screen.findByRole('button', { name: 'Stop external writes' })).toBeVisible();
    expect(screen.getByText('allowed')).toBeVisible();
  });

  it('surfaces the four-eyes refusal from the server', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ ...allowed, active: true, pausedAt: '2026-09-23T12:00:00Z', pauseReason: 'Contain' }))
      .mockResolvedValueOnce(json({
        type: 'four-eyes-required', title: 'A second administrator must resume writes',
        status: 403, detail: 'A different administrator must resume external writes',
      }, 403));
    render(<TenantWriteStopPanel />);
    await userEvent.type(await screen.findByLabelText('Reason for resuming'), 'Fixed');
    await userEvent.click(screen.getByRole('button', { name: 'Request reviewed resume' }));
    expect(await screen.findByText('A different administrator must resume external writes')).toBeVisible();
  });
});
