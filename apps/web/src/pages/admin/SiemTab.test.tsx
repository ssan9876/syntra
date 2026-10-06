import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SiemTab, type AuditStream } from './SiemTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stream = (over: Partial<AuditStream> = {}): AuditStream => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Splunk',
  enabled: true,
  transport: 'https',
  format: 'splunk-hec',
  url: 'https://splunk.acme.example:8088/services/collector/event',
  host: null,
  port: null,
  tls: true,
  authHeader: 'Authorization',
  hasCredential: true,
  behind: 0,
  status: 'delivering',
  lastDeliveredAt: '2026-10-06T12:00:00Z',
  lastError: null,
  lastErrorAt: null,
  consecutiveFailures: 0,
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SiemTab', () => {
  it('shows each stream with its destination and state, failures with their reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        streams: [
          stream(),
          stream({ id: '2', name: 'QRadar', transport: 'syslog', format: 'cef', url: null, host: 'qradar.acme.example', port: 6514, status: 'failing', lastError: 'ECONNREFUSED', consecutiveFailures: 4 }),
          stream({ id: '3', name: 'Archive', status: 'behind', behind: 12_500 }),
        ],
      }),
    );
    render(<SiemTab />);
    const table = await screen.findByRole('table', { name: 'SIEM streams' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Splunk HEC');
    expect(rows[0]).toHaveTextContent('Delivering');
    expect(rows[1]).toHaveTextContent('qradar.acme.example:6514 (TLS)');
    expect(rows[1]).toHaveTextContent('Failing');
    expect(rows[1]).toHaveTextContent('ECONNREFUSED');
    expect(rows[2]).toHaveTextContent('Behind by 12,500');
  });

  it('adds a syslog stream, offering only the formats syslog takes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
      Promise.resolve(init?.method === 'POST' ? json({ stream: stream() }, 201) : json({ streams: [] })),
    );
    render(<SiemTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add stream' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add SIEM stream' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'QRadar');
    await userEvent.selectOptions(within(dialog).getByLabelText('Send over'), 'syslog');
    expect(within(within(dialog).getByLabelText('Format')).getAllByRole('option').map((o) => o.textContent)).toEqual(['JSON', 'CEF']);
    await userEvent.selectOptions(within(dialog).getByLabelText('Format'), 'cef');
    await userEvent.type(within(dialog).getByLabelText('Host'), 'qradar.acme.example');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/audit-streams', expect.objectContaining({ method: 'POST' })));
    const sent = JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body));
    expect(sent).toMatchObject({ name: 'QRadar', transport: 'syslog', format: 'cef', host: 'qradar.acme.example', port: 6514, tls: true, url: null, startFrom: 'now' });
  });

  it('reports what the receiver said when a test fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/test') && init?.method === 'POST') {
        return Promise.resolve(json({ type: 'x/audit-stream-test-failed', title: 'Test event not accepted', status: 422, detail: 'https://splunk.acme.example:8088/services/collector/event: HTTP 403: Invalid token' }, 422));
      }
      return Promise.resolve(json({ streams: [stream()] }));
    });
    render(<SiemTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test event not accepted')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 403: Invalid token/)).toBeInTheDocument();
  });
});
