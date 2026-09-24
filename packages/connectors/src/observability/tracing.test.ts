import { describe, expect, it, vi } from 'vitest';
import {
  currentCorrelationId,
  isCorrelationId,
  JOB_TRACE_KEY,
  jobTraceCarrier,
  newCorrelationId,
  safeAttributes,
  splitJobPayload,
  traceConnector,
  traceFetch,
  tracingEnabled,
  withCorrelation,
  withSpan,
} from './tracing.js';

/**
 * Tracing OFF -- the default, and the state every other test in the suite
 * runs in. What is asserted here is the "zero cost" promise: nothing is
 * wrapped, nothing is allocated, the correlation id still flows. The ON
 * behaviour is exercised end to end, against a real in-memory exporter, in
 * `apps/api/src/telemetry.test.ts`.
 */
describe('tracing when disabled', () => {
  it('is disabled by default', () => {
    expect(tracingEnabled()).toBe(false);
  });

  it('hands back the connector itself, not a proxy', () => {
    const connector = { read: async () => 1 };
    expect(traceConnector('scim2', connector)).toBe(connector);
  });

  it('calls straight through to the fetch and the span body', async () => {
    const response = new Response('ok');
    const inner = vi.fn(async () => response);
    await expect(traceFetch(inner)('https://h.test/x')).resolves.toBe(response);
    expect(inner).toHaveBeenCalledOnce();
    await expect(withSpan('x', {}, async (span) => span)).resolves.toBeNull();
  });
});

describe('correlation', () => {
  it('is absent outside a request or job and present inside one, across awaits', async () => {
    expect(currentCorrelationId()).toBeNull();
    const id = newCorrelationId();
    expect(isCorrelationId(id)).toBe(true);
    await withCorrelation(id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentCorrelationId()).toBe(id);
    });
    expect(currentCorrelationId()).toBeNull();
  });

  it('refuses anything that is not 32 lower-case hex characters', () => {
    for (const bad of ['', 'x'.repeat(32), '0'.repeat(32), 'ABCDEF0123456789ABCDEF0123456789', "'; drop table", null, 42]) {
      expect(isCorrelationId(bad)).toBe(false);
    }
  });
});

describe('job payload carrier', () => {
  it('adds nothing outside a request or job', () => {
    expect(jobTraceCarrier()).toBeNull();
  });

  it('carries the correlation id (and no trace context while tracing is off)', () => {
    const id = newCorrelationId();
    expect(withCorrelation(id, () => jobTraceCarrier())).toEqual({ correlationId: id });
  });

  it('is stripped before a handler sees the payload', () => {
    const id = newCorrelationId();
    const { data, carrier } = splitJobPayload({ tenantId: 't', [JOB_TRACE_KEY]: { correlationId: id, traceparent: '00-x' } });
    expect(data).toEqual({ tenantId: 't' });
    expect(carrier).toEqual({ correlationId: id, traceparent: '00-x' });
  });

  it('drops a malformed carrier rather than trusting stored content', () => {
    const { data, carrier } = splitJobPayload({ tenantId: 't', [JOB_TRACE_KEY]: { correlationId: 'jane.doe@acme.test' } });
    expect(data).toEqual({ tenantId: 't' });
    expect(carrier).toBeNull();
  });

  it('leaves payloads without a carrier untouched', () => {
    const payload = { tenantId: 't' };
    expect(splitJobPayload(payload)).toEqual({ data: payload, carrier: null });
    expect(splitJobPayload(null)).toEqual({ data: null, carrier: null });
  });
});

describe('safeAttributes', () => {
  it('keeps ids and operation names, drops secrets and personal data, scrubs text', () => {
    expect(
      safeAttributes({
        'syntra.tenant_id': '4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11',
        'syntra.connector.operation': 'apply',
        'syntra.bind_password': 'Sup3rS3cret!',
        'user.email': 'jane.doe@acme.test',
        'syntra.note': 'failed for jane.doe@acme.test',
        'http.response.status_code': 503,
        nested: { a: 1 },
      }),
    ).toEqual({
      'syntra.tenant_id': '4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11',
      'syntra.connector.operation': 'apply',
      'syntra.note': 'failed for [redacted:email]',
      'http.response.status_code': 503,
    });
  });
});
