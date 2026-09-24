import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExportsTab, type ExportRow } from './ExportsTab.js';

const granted = new Set<string>();
vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  id: 'x-1',
  kind: 'audit_log',
  status: 'ready',
  requestedByUserId: 'u-1',
  requestedAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2026-09-24T10:00:00.000Z',
  rowCount: 42,
  byteLength: 2048,
  sha256: 'a'.repeat(64),
  error: null,
  downloadCount: 0,
  ...over,
});

function mockApi(lists: ExportRow[][]) {
  const calls: { url: string; method: string }[] = [];
  let listed = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST' && url.endsWith('/revoke')) {
      return Promise.resolve(json({ export: row({ status: 'revoked' }) }));
    }
    const exports = lists[Math.min(listed, lists.length - 1)]!;
    listed += 1;
    return Promise.resolve(json({ exports }));
  });
  return calls;
}

const renderTab = () =>
  render(
    <MemoryRouter>
      <ExportsTab />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
});

describe('ExportsTab', () => {
  it('offers the download of a ready export as a plain link to the download route', async () => {
    mockApi([[row()]]);
    renderTab();
    const link = await screen.findByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', '/api/admin/exports/x-1/download');
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('offers no download for an export that failed, expired or was revoked, and shows why it failed', async () => {
    mockApi([
      [
        row({ id: 'a', status: 'failed', error: 'the export would exceed 64 MiB; narrow the filters' }),
        row({ id: 'b', status: 'expired' }),
        row({ id: 'c', status: 'revoked' }),
      ],
    ]);
    renderTab();
    expect(await screen.findByText(/would exceed 64 MiB/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('follows a generating export and announces when it is ready', async () => {
    mockApi([[row({ status: 'running' })], [row({ status: 'ready' })]]);
    renderTab();
    expect(await screen.findByText('Generating')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument(), { timeout: 5000 });
    // Waited for, not read at once: the row turns Ready in the render that
    // follows the poll, and the live region is written in the effect after
    // it, which a slow runner reaches measurably later.
    await waitFor(() =>
      expect(
        screen.getAllByRole('status').some((el) => el.textContent?.includes('Audit log export: ready')),
      ).toBe(true),
    );
  });

  it('revokes, and says the file was erased', async () => {
    const calls = mockApi([[row()], [row({ status: 'revoked' })]]);
    renderTab();
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/admin/exports/x-1/revoke')).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((el) => el.textContent?.includes('file has been erased'))).toBe(true),
    );
  });

  it('shows everyone’s exports only to a tenant administrator', async () => {
    const calls = mockApi([[row()]]);
    renderTab();
    await screen.findByText('Ready');
    expect(screen.queryByRole('button', { name: 'Everyone’s' })).toBeNull();

    granted.add('tenant.manage');
    const second = renderTab();
    await userEvent.click(within(second.container).getByRole('button', { name: 'Everyone’s' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/admin/exports?scope=all')).toBe(true));
  });
});
