import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuditTab, auditQuery } from './AuditTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const event = (sequence: number, action = 'auth.login') => ({
  id: `e-${sequence}`,
  sequence,
  occurredAt: '2026-09-20T10:00:00.000Z',
  actorUserId: null,
  action,
  targetType: 'User',
  targetId: null,
  outcome: 'success',
  sourceIp: null,
  payload: {},
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function mockApi(pages: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith('/api/admin/audit/views')) {
      return Promise.resolve(method === 'GET' ? json({ views: [] }) : json({ view: {} }));
    }
    if (url.startsWith('/api/admin/exports')) return Promise.resolve(json({ export: { id: 'x-1' } }, 202));
    if (url.startsWith('/api/admin/audit')) {
      const before = new URL(url, 'http://t').searchParams.get('before');
      const page = pages[before ?? 'first'] ?? { events: [event(2), event(1)], nextBefore: null, chainValid: true };
      return Promise.resolve(json(page));
    }
    return Promise.resolve(json({}));
  });
  return calls;
}

const renderTab = () =>
  render(
    <MemoryRouter>
      <AuditTab />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('AuditTab', () => {
  it('builds the query from the filters and leaves empty ones out', () => {
    expect(auditQuery({ action: 'auth.', outcome: 'failure' }, 40)).toBe(
      '/api/admin/audit?limit=50&action=auth.&outcome=failure&before=40',
    );
    expect(auditQuery({}, null)).toBe('/api/admin/audit?limit=50');
  });

  it('searches on the server with the filters as submitted', async () => {
    const calls = mockApi();
    renderTab();
    await screen.findByText('2');
    await userEvent.type(screen.getByLabelText('Action starts with'), 'user.');
    await userEvent.selectOptions(screen.getByLabelText('Outcome'), 'failure');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/admin/audit?limit=50&action=user.&outcome=failure')).toBe(true),
    );
  });

  it('pages older with the keyset cursor and back newer without asking the server to page up', async () => {
    const calls = mockApi({
      first: { events: [event(60), event(59)], nextBefore: 59, chainValid: true },
      '59': { events: [event(58)], nextBefore: null, chainValid: true },
    });
    renderTab();
    await screen.findByText('60');
    expect(screen.getByText('Entries 59–60')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Older' }));
    await screen.findByText('58');
    expect(calls.some((c) => c.url.endsWith('before=59'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Older' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Newer' }));
    await screen.findByText('60');
    expect(screen.getByRole('button', { name: 'Newer' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('hands “export these results” to the export service with the filters in effect, and says so', async () => {
    const calls = mockApi();
    renderTab();
    await screen.findByText('2');
    await userEvent.type(screen.getByLabelText('Action starts with'), 'auth.');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export these results' }));
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/admin/exports' && c.method === 'POST');
      expect(post?.body).toEqual({ kind: 'audit_log', params: { action: 'auth.' } });
    });
    const status = screen.getAllByRole('status').find((el) => el.textContent?.includes('Export requested'));
    expect(status).toBeDefined();
    expect(screen.getByRole('link', { name: /follow it in exports/i })).toHaveAttribute(
      'href',
      '/admin/activity?tab=exports',
    );
  });

  it('saves the current search under a name', async () => {
    const calls = mockApi();
    renderTab();
    await screen.findByText('2');
    await userEvent.selectOptions(screen.getByLabelText('Outcome'), 'failure');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.type(screen.getByLabelText('Save this search as'), 'Failures');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put?.body).toEqual({ name: 'Failures', filters: { outcome: 'failure' } });
    });
  });

  it('still leads with the warning when the chain does not verify', async () => {
    mockApi({ first: { events: [event(1)], nextBefore: null, chainValid: false, brokenAtSequence: 1 } });
    renderTab();
    expect(await screen.findByText('This audit log has been altered')).toBeInTheDocument();
  });
});
