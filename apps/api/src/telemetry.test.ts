import Fastify from 'fastify';
import { context, propagation, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';
import {
  currentCorrelationId,
  disableTracing,
  enableTracing,
  traceConnector,
  traceFetch,
} from '@syntra/connectors';
import { runJob, withJobTrace } from '@syntra/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loggerOptions } from './logging.js';
import { registerTracing } from './plugins/tracing.js';
import { startTelemetry, tracingConfigured } from './telemetry.js';

/**
 * Backlog #55 with tracing ON, against a real SDK and an in-memory exporter.
 *
 * The chain under test is the one the backlog names: a request (standing in
 * for an HR import trigger) enqueues a job; the job runs a connector
 * operation; the connector makes an outbound HTTP call. All four must land in
 * ONE trace with the right parentage, the request's correlation id must be the
 * trace id, and no span may carry a secret or a person.
 *
 * The job is run through `runJob` -- the exact function the pg-boss worker
 * calls -- with the payload `withJobTrace` produced, which is what pg-boss
 * would have stored. The pg-boss round trip itself is covered by
 * `packages/core/src/jobs/scheduler.test.ts`.
 */
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  provider.register();
  enableTracing();
});

afterAll(async () => {
  disableTracing();
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

beforeEach(() => exporter.reset());

const PLANTED = ['ghp_live_R4nd0mT0kenValue0123456789ABCdef', 'Sup3rS3cretBindPw!', 'jane.doe@acme.test', 'Jane Doe'];

function everythingOn(spans: ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((span) => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events })),
  );
}

describe('tracing enabled', () => {
  it('puts request -> job -> connector -> outbound HTTP in one trace, with nothing sensitive on any span', async () => {
    const app = Fastify({ logger: loggerOptions({ stream: { write: () => undefined } }) });
    registerTracing(app);

    // A fake outbound call standing in for `guardedFetch`'s socket work.
    const fetchOnce = traceFetch(async () => new Response('{}', { status: 201 }));
    const connector = traceConnector('scim2', {
      async apply(config: { bearerToken: string }, person: { displayName: string }) {
        return fetchOnce(`https://scim.example.test/Users?filter=userName eq "jane.doe@acme.test"`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.bearerToken}` },
          body: JSON.stringify(person),
        });
      },
    });

    let stored: unknown;
    let requestCorrelation: string | undefined;
    app.post('/api/admin/person-sources/:id/import', async (request) => {
      requestCorrelation = request.correlationId;
      // What `scheduler.enqueue` stores.
      stored = withJobTrace({ tenantId: '4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11', sourceId: 's-1' });
      return { queued: true };
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/person-sources/0f0e/import?token=Sup3rS3cretBindPw!',
      payload: { email: 'jane.doe@acme.test' },
    });
    expect(response.statusCode).toBe(200);
    await app.close();

    let jobCorrelation: string | null = null;
    await runJob('personSource.run', { id: 'job-1', data: stored, retryCount: 0 }, async (data) => {
      // The carrier never reaches a handler.
      expect(Object.keys(data as object).sort()).toEqual(['sourceId', 'tenantId']);
      jobCorrelation = currentCorrelationId();
      await connector.apply({ bearerToken: 'ghp_live_R4nd0mT0kenValue0123456789ABCdef' }, { displayName: 'Jane Doe' });
    });

    const spans = exporter.getFinishedSpans();
    const byName = (name: string) => spans.find((span) => span.name === name)!;
    const server = byName('POST /api/admin/person-sources/:id/import');
    const job = byName('job personSource.run');
    const operation = byName('connector.scim2.apply');
    const http = byName('HTTP POST');

    // One trace, correctly parented.
    const traceId = server.spanContext().traceId;
    for (const span of [job, operation, http]) expect(span.spanContext().traceId).toBe(traceId);
    expect(job.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(operation.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
    expect(http.parentSpanContext?.spanId).toBe(operation.spanContext().spanId);

    // The correlation id IS the trace id, end to end.
    expect(requestCorrelation).toBe(traceId);
    expect(response.headers['x-correlation-id']).toBe(traceId);
    expect(jobCorrelation).toBe(traceId);

    // What is on the spans is what an operator filters by.
    expect(server.attributes).toMatchObject({
      'http.request.method': 'POST',
      'http.route': '/api/admin/person-sources/:id/import',
      'http.response.status_code': 200,
    });
    expect(job.attributes).toMatchObject({
      'messaging.destination.name': 'personSource.run',
      'syntra.tenant_id': '4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11',
    });
    expect(http.attributes).toMatchObject({ 'server.address': 'scim.example.test', 'http.response.status_code': 201 });

    // And nothing else: no path, no query, no header, no body, no person.
    const all = everythingOn(spans);
    for (const planted of PLANTED) expect(all, planted).not.toContain(planted);
    expect(all).not.toContain('/Users');
    expect(all).not.toContain('0f0e');
  });

  it('records a failure as a type and a scrubbed message, never the raw exception', async () => {
    const connector = traceConnector('activeDirectory', {
      async apply() {
        throw Object.assign(new Error('bind as CN=Jane Doe,OU=Staff,DC=acme,DC=test with password=Sup3rS3cretBindPw! failed'), {
          name: 'InvalidCredentialsError',
          code: 49,
        });
      },
    });
    await expect(connector.apply()).rejects.toThrow('bind as');

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(2);
    expect(span!.attributes['syntra.error.code']).toBe(49);
    expect(span!.events).toEqual([]);
    const all = everythingOn([span!]);
    for (const planted of PLANTED) expect(all, planted).not.toContain(planted);
    expect(span!.status.message).toContain('DC=acme,DC=test');
  });

  it('spans an async-iterable read until iteration ends', async () => {
    const connector = traceConnector('ldap', {
      async *read() {
        yield 1;
        yield 2;
      },
    });
    const seen: number[] = [];
    for await (const record of connector.read()) seen.push(record);
    expect(seen).toEqual([1, 2]);
    const [span] = exporter.getFinishedSpans();
    expect(span!.name).toBe('connector.ldap.read');
    expect(span!.attributes['syntra.connector.records']).toBe(2);
  });
});

describe('telemetry bootstrap', () => {
  it('is off without an endpoint and when explicitly disabled', async () => {
    expect(tracingConfigured({})).toBe(false);
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBe(false);
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SDK_DISABLED: 'true' })).toBe(false);
    expect(tracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true);
    const telemetry = await startTelemetry({}, { version: 'test' });
    expect(telemetry.enabled).toBe(false);
    await telemetry.shutdown();
  });
});
