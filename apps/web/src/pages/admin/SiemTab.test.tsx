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
  actionPrefixes: [],
  outcome: null,
  cursor: 40,
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

  it('shows a stream\'s filter, saves one, and keeps it when pausing', async () => {
    const filtered = stream({ actionPrefixes: ['auth.', 'user.'], outcome: 'failure' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
      Promise.resolve(init?.method === 'PUT' ? json({ stream: filtered }) : json({ streams: [filtered] })),
    );
    render(<SiemTab />);
    const table = await screen.findByRole('table', { name: 'SIEM streams' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('auth., user. · Failures only');

    await userEvent.click(within(table).getByRole('button', { name: 'Pause' }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/admin/audit-streams/'), expect.objectContaining({ method: 'PUT' })));
    const paused = JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!.body));
    expect(paused).toMatchObject({ enabled: false, actionPrefixes: ['auth.', 'user.'], outcome: 'failure' });

    fetch.mockClear();
    await userEvent.click(within(table).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Splunk' });
    const prefixes = within(dialog).getByLabelText('Actions starting with');
    expect(prefixes).toHaveValue('auth., user.');
    await userEvent.clear(prefixes);
    await userEvent.type(prefixes, 'provision., , auth.');
    await userEvent.selectOptions(within(dialog).getByLabelText('Outcome'), '');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'PUT' })));
    const saved = JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!.body));
    expect(saved).toMatchObject({ actionPrefixes: ['provision.', 'auth.'], outcome: null });
  });

  it('lists deliveries and resends from an event number', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/deliveries')) {
        return Promise.resolve(
          json({
            deliveries: [
              { id: 'd2', at: '2026-10-07T12:01:00Z', kind: 'batch', firstSequence: 41, lastSequence: 240, count: 200, ok: false, error: 'HTTP 503: busy', durationMs: 1200 },
              { id: 'd1', at: '2026-10-07T12:00:00Z', kind: 'test', firstSequence: null, lastSequence: null, count: 1, ok: true, error: null, durationMs: 80 },
            ],
          }),
        );
      }
      if (url.endsWith('/replay')) return Promise.resolve(json({ stream: stream({ cursor: 9, behind: 300 }) }));
      return Promise.resolve(json({ streams: [stream()] }));
    });
    render(<SiemTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    const dialog = await screen.findByRole('dialog', { name: 'Splunk history' });
    const rows = within(await within(dialog).findByRole('table', { name: 'Deliveries' })).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('#41–240 (200)');
    expect(rows[0]).toHaveTextContent('Refused');
    expect(rows[0]).toHaveTextContent('HTTP 503: busy');
    expect(rows[1]).toHaveTextContent('Test event');
    expect(rows[1]).toHaveTextContent('Accepted');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Resend…' }));
    const resend = await screen.findByRole('dialog', { name: 'Resend to Splunk' });
    await userEvent.selectOptions(within(resend).getByLabelText('Resend from'), 'sequence');
    await userEvent.type(within(resend).getByLabelText('Event number'), '10');
    await userEvent.click(within(resend).getByRole('button', { name: 'Resend' }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/replay$/), expect.objectContaining({ method: 'POST' })));
    const sent = JSON.parse(String(fetch.mock.calls.find(([input]) => String(input).endsWith('/replay'))![1]!.body));
    expect(sent).toEqual({ from: 'sequence', sequence: 10 });
    expect(await screen.findByText('Sent up to event #9. 300 waiting.')).toBeInTheDocument();
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
