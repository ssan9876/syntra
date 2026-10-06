import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RestoreHoldBanner } from './RestoreHoldBanner.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const held = (mayResume: boolean) => ({
  hold: {
    backupName: 'syntra-20261005T020000Z',
    backupTakenAt: '2026-10-05T02:00:00.000Z',
    backupVersion: '1.20.0',
    restoredAt: '2026-10-05T14:12:00.000Z',
  },
  mayResume,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('RestoreHoldBanner', () => {
  it('shows nothing when no restore is waiting', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ hold: null, mayResume: false }));
    const { container } = render(<RestoreHoldBanner />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('names the backup and offers no button without deployment.manage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(held(false)));
    render(<RestoreHoldBanner />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Background work paused after restore');
    expect(alert).toHaveTextContent('Restored from syntra-20261005T020000Z');
    expect(within(alert).queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('resumes after confirmation and disappears', async () => {
    let resumed = false;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/resume') && init?.method === 'POST') {
        resumed = true;
        return Promise.resolve(json({ resumed: true }));
      }
      return Promise.resolve(json(resumed ? { hold: null, mayResume: false } : held(true)));
    });
    render(<RestoreHoldBanner />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume background work?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
    await vi.waitFor(() => expect(screen.queryByText('Background work paused after restore')).toBeNull());
    expect(fetch).toHaveBeenCalledWith('/api/admin/restore-hold/resume', expect.objectContaining({ method: 'POST' }));
  });
});
