import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BackupsPage, type BackupRow, type BackupsResponse } from './BackupsPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const row = (over: Partial<BackupRow> = {}): BackupRow => ({
  name: 'syntra-20261005T020000Z',
  createdAt: '2026-10-05T02:00:00Z',
  version: '1.20.0',
  bytes: 5 * 1024 * 1024,
  kind: 'scheduled',
  key: 'match',
  versionCheck: 'ok',
  ...over,
});

const configured = (backups: BackupRow[]): BackupsResponse => ({
  configured: true,
  version: '1.20.0',
  backups,
  status: {
    intervalHours: 1,
    retention: { hourly: 48, daily: 14, weekly: 8, manual: 10 },
    copyConfigured: false,
    current: null,
    recent: [],
  },
});

function renderPage() {
  return render(
    <MemoryRouter>
      <BackupsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('BackupsPage', () => {
  it('says when no backup service is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ configured: false, version: '1.20.0', backups: [], status: null }));
    renderPage();
    expect(await screen.findByText('No backup service configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back up now' })).toBeNull();
  });

  it('lists restore points with schedule, kind, size and key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(configured([row(), row({ name: 'syntra-20261004T020000Z-upload', kind: 'uploaded', key: 'mismatch' })])),
    );
    renderPage();
    const table = await screen.findByRole('table', { name: 'Backups' });
    expect(screen.getByText('Every hour')).toBeInTheDocument();
    expect(screen.getByText('48 hourly · 14 daily · 8 weekly')).toBeInTheDocument();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Scheduled');
    expect(rows[0]).toHaveTextContent('5.0 MB');
    expect(rows[0]).toHaveTextContent('Same');
    expect(rows[1]).toHaveTextContent('Uploaded');
    expect(rows[1]).toHaveTextContent('Different');
    expect(within(rows[1]!).getByRole('button', { name: 'Restore' })).toBeDisabled();
    expect(within(rows[0]!).getByRole('button', { name: 'Restore' })).toBeEnabled();

    // The phone layout: the same backups as cards, the same rule on Restore.
    const cards = within(screen.getByRole('list', { name: 'Backups' })).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[1]).toHaveTextContent('Uploaded · 1.20.0 · 5.0 MB');
    expect(within(cards[1]!).getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  it('starts a restore only once the backup name is typed', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/restore') && init?.method === 'POST') {
        return Promise.resolve(json({ job: { id: 'job-1', kind: 'restore', state: 'running', step: 'Starting' } }, 202));
      }
      if (String(input).includes('/jobs/')) {
        return Promise.resolve(json({ job: { id: 'job-1', kind: 'restore', state: 'running', step: 'Loading the backup into the database' } }));
      }
      return Promise.resolve(json(configured([row()])));
    });
    renderPage();
    const table = await screen.findByRole('table', { name: 'Backups' });
    await userEvent.click(within(table).getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Every tenant goes back to this backup.');
    const confirm = within(dialog).getByRole('button', { name: 'Restore' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Type syntra-20261005T020000Z'), 'syntra-20261005T020000Z');
    await userEvent.click(confirm);
    expect(await screen.findByText('Restoring syntra-20261005T020000Z')).toBeInTheDocument();
    expect(await screen.findByText('Loading the backup into the database')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/backups/syntra-20261005T020000Z/restore',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: 'syntra-20261005T020000Z' }) }),
    );
  });

  it('asks for a passphrase of at least 12 characters, twice, to download', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(configured([row()])));
    renderPage();
    const table = await screen.findByRole('table', { name: 'Backups' });
    await userEvent.click(within(table).getByRole('button', { name: 'Download' }));
    const dialog = await screen.findByRole('dialog', { name: 'Download backup' });
    const download = within(dialog).getByRole('button', { name: 'Download' });
    await userEvent.type(within(dialog).getByLabelText('Passphrase'), 'short');
    expect(dialog).toHaveTextContent('At least 12 characters.');
    await userEvent.clear(within(dialog).getByLabelText('Passphrase'));
    await userEvent.type(within(dialog).getByLabelText('Passphrase'), 'correct horse battery');
    await userEvent.type(within(dialog).getByLabelText('Passphrase again'), 'correct horse');
    expect(dialog).toHaveTextContent('Does not match.');
    expect(download).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Passphrase again'), ' battery');
    expect(download).toBeEnabled();
  });
});
