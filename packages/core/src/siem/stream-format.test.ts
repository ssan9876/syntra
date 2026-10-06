import { describe, expect, it } from 'vitest';
import { cefLine, eventJson, httpsJsonBody, octetFrame, splunkHecBody, syslogMessage, type StreamableEvent } from './stream-format.js';

const event = (over: Partial<StreamableEvent> = {}): StreamableEvent => ({
  id: '0b9d5a2e-0000-4000-8000-000000000001',
  sequence: 42,
  occurredAt: new Date('2026-10-06T12:00:00.000Z'),
  actorUserId: '0b9d5a2e-0000-4000-8000-0000000000aa',
  action: 'auth.login',
  targetType: 'User',
  targetId: '0b9d5a2e-0000-4000-8000-0000000000aa',
  outcome: 'failure',
  sourceIp: '203.0.113.7',
  correlationId: 'abc123',
  payload: { reason: 'bad password' },
  hash: 'h42',
  prevHash: 'h41',
  ...over,
});
const ctx = { tenant: 'acme', host: 'idm.acme.example', version: '1.22.0' };

describe('SIEM formats', () => {
  it('carries the tenant and the hash chain in every event', () => {
    expect(eventJson(event(), ctx)).toMatchObject({ tenant: 'acme', sequence: 42, hash: 'h42', prevHash: 'h41', occurredAt: '2026-10-06T12:00:00.000Z' });
    expect(JSON.parse(httpsJsonBody([event(), event({ sequence: 43 })], ctx)).map((e: { sequence: number }) => e.sequence)).toEqual([42, 43]);
  });

  it('writes Splunk HEC batches as one event object per line', () => {
    const lines = splunkHecBody([event(), event({ sequence: 43 })], ctx).split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ time: 1791288000, host: 'idm.acme.example', sourcetype: 'syntra:audit', event: { sequence: 42 } });
  });

  it('writes RFC 5424 with facility "log audit", structured data, and the JSON as the message', () => {
    const message = syslogMessage(event(), ctx, 'json');
    // <13*8+4> for a failure: warning.
    expect(message).toMatch(/^<108>1 2026-10-06T12:00:00\.000Z idm\.acme\.example syntra - auth\.login \[syntra@32473 tenant="acme" sequence="42" outcome="failure"\] \{/);
    expect(JSON.parse(message.slice(message.indexOf('] ') + 2))).toMatchObject({ action: 'auth.login' });
    expect(syslogMessage(event({ outcome: 'success' }), ctx, 'json')).toMatch(/^<109>1 /);
  });

  it('escapes structured-data values', () => {
    expect(syslogMessage(event(), { ...ctx, tenant: 'a"b]c\\d' }, 'json')).toContain('tenant="a\\"b\\]c\\\\d"');
  });

  it('frames by byte count, not character count', () => {
    expect(octetFrame('héllo')).toBe('6 héllo');
  });

  it('writes CEF with header and extension escaping', () => {
    const line = cefLine(event({ action: 'a|b', payload: null, sourceIp: null, correlationId: 'x=y\nz' }), ctx);
    expect(line.startsWith('CEF:0|Syntra|Syntra|1.22.0|a\\|b|a\\|b|7|')).toBe(true);
    expect(line).toContain('act=a|b');
    expect(line).toContain('cs3=x\\=y\\nz');
    expect(line).toContain('cn1=42');
    expect(line).not.toContain('src=');
    expect(cefLine(event({ outcome: 'success' }), ctx).split('|')[6]).toBe('3');
  });
});
