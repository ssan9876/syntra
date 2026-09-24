import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { isPersonalKey, isSecretKey, scrubText } from './redact.js';

// Re-exported so core and the API name span kinds without each taking their
// own dependency on the API package (and risking a second copy of it).
export { SpanKind } from '@opentelemetry/api';

/**
 * Correlation and tracing primitives shared by the API, the job runner, core
 * and the connectors.
 *
 * TWO THINGS, deliberately separate:
 *
 *  1. A CORRELATION ID, always on. One 32-hex id per HTTP request or job run,
 *     carried in an `AsyncLocalStorage`, stamped on every log line, written to
 *     every audit event and passed through job payloads, so an HR import, the
 *     provisioning run it caused and the connector calls that run made share
 *     one id whether or not anybody runs a tracing backend. Its cost is one
 *     `getStore()` per log line and a few dozen bytes per job.
 *
 *  2. OPENTELEMETRY SPANS, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set
 *     (see `apps/api/src/telemetry.ts`). This module depends only on
 *     `@opentelemetry/api`, whose global tracer is a no-op until an SDK
 *     registers one, and every helper below checks `tracingEnabled()` FIRST
 *     and calls straight through when it is false -- no span objects, no
 *     context switches, no closures kept alive. "Zero cost when off" is meant
 *     literally.
 *
 * When tracing is on the two are the same number: the correlation id IS the
 * trace id, so an id copied from an audit event pastes straight into the
 * tracing backend's search box.
 *
 * NOTHING SENSITIVE ON A SPAN. Span attributes go to a third-party backend
 * with its own retention and access model, so they are held to a stricter
 * rule than logs: `safeAttributes` drops every key the redaction rules call a
 * secret or personal, scrubs every string, and callers only ever pass ids,
 * names of operations, hosts and counts. Errors become a type and a scrubbed
 * message -- never `span.recordException`, which would copy the raw message
 * and stack.
 */

const TRACER_NAME = 'syntra';

let enabled = false;

/** Called once by the telemetry bootstrap after an SDK is registered. */
export function enableTracing(): void {
  enabled = true;
}

/** Test seam, and what the telemetry bootstrap calls on shutdown. */
export function disableTracing(): void {
  enabled = false;
}

export function tracingEnabled(): boolean {
  return enabled;
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

interface CorrelationStore {
  correlationId: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationStore>();

const CORRELATION_ID = /^[0-9a-f]{32}$/;
const INVALID_TRACE_ID = '0'.repeat(32);

/** A fresh id, in W3C trace-id format so it can double as one. */
export function newCorrelationId(): string {
  return randomBytes(16).toString('hex');
}

/** Whether a value is a well-formed correlation id. Anything else is refused. */
export function isCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID.test(value) && value !== INVALID_TRACE_ID;
}

/**
 * The id of the request or job this code is running for, or `null` outside
 * one (a boot-time task, a test calling a service directly).
 */
export function currentCorrelationId(): string | null {
  return correlationStorage.getStore()?.correlationId ?? null;
}

/** Run `fn` with `correlationId` as the current correlation id. */
export function withCorrelation<T>(correlationId: string, fn: () => T): T {
  return correlationStorage.run({ correlationId }, fn);
}

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

const MAX_ATTRIBUTE_STRING = 256;

/**
 * Attributes with every secret and personal key removed and every string
 * scrubbed and bounded. Tenant ids and other opaque ids survive: they are what
 * an operator filters by and they identify no person.
 */
export function safeAttributes(input: Record<string, unknown>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    // The whole dotted key is classified: `syntra.bind_password` is a secret,
    // `user.email` is personal, `server.address` is infrastructure.
    if (isSecretKey(key) || isPersonalKey(key)) continue;
    const safe = safeAttributeValue(value);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

function safeAttributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string') return scrubText(value, MAX_ATTRIBUTE_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const strings = value.filter((v): v is string => typeof v === 'string').slice(0, 20);
    return strings.map((v) => scrubText(v, MAX_ATTRIBUTE_STRING));
  }
  return undefined;
}

/**
 * Mark a span failed with the error's TYPE and a scrubbed message. Not
 * `recordException`: that copies the raw message and the stack into an event,
 * and the raw message is precisely where a connector puts the DN it bound as.
 */
export function recordSpanError(span: Span, error: unknown): void {
  const type = error instanceof Error ? (error.constructor?.name ?? error.name) : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  span.setAttribute('error.type', type);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' || typeof code === 'number') {
    span.setAttribute('syntra.error.code', typeof code === 'string' ? scrubText(code, 64) : code);
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message: scrubText(message, MAX_ATTRIBUTE_STRING) });
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, unknown>;
  /** A parent other than the active one -- a job's extracted trace context. */
  parent?: Context;
}

/**
 * Run `fn` inside a span when tracing is on, and simply run it when it is
 * off. The span ends when the returned promise settles; a throw marks it
 * failed (safely) and is rethrown unchanged.
 */
export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  if (!enabled) return fn(null);
  const tracer = trace.getTracer(TRACER_NAME);
  const parent = options.parent ?? context.active();
  return tracer.startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: safeAttributes(options.attributes ?? {}) },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Start a span without making it active -- for the Fastify hooks, which end it later. */
export function startSpan(name: string, options: SpanOptions): Span | null {
  if (!enabled) return null;
  return trace
    .getTracer(TRACER_NAME)
    .startSpan(
      name,
      { kind: options.kind ?? SpanKind.INTERNAL, attributes: safeAttributes(options.attributes ?? {}) },
      options.parent ?? context.active(),
    );
}

/** The trace id of `span`, if it is a real (sampled or not) span. */
export function traceIdOf(span: Span | null): string | null {
  if (!span) return null;
  const id = span.spanContext().traceId;
  return isCorrelationId(id) ? id : null;
}

/** The active span's trace and span ids, for stamping on a log line. */
export function activeTraceIds(): { traceId: string; spanId: string } | null {
  if (!enabled) return null;
  const span = trace.getActiveSpan();
  if (!span) return null;
  const { traceId, spanId } = span.spanContext();
  return isCorrelationId(traceId) ? { traceId, spanId } : null;
}

/** Extract a parent context from W3C headers (`traceparent`, `tracestate`). */
export function extractContext(carrier: Record<string, unknown>): Context {
  return propagation.extract(context.active(), carrier, {
    get: (c, key) => {
      const value = (c as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] as string | undefined) : undefined;
    },
    keys: (c) => Object.keys(c as object),
  });
}

/** Run `fn` with `span` as the active span, if there is one. */
export function withActiveSpan<T>(span: Span | null, fn: () => T): T {
  if (!span) return fn();
  return context.with(trace.setSpan(context.active(), span), fn);
}

// ---------------------------------------------------------------------------
// Job payload propagation
// ---------------------------------------------------------------------------

/**
 * The key a job payload carries its trace context under. Underscored and
 * namespaced so it cannot collide with a handler's own field, and stripped by
 * the runner before the handler sees the payload, so no handler's schema has
 * to know about it.
 */
export const JOB_TRACE_KEY = '_syntraTrace';

export interface JobTraceCarrier {
  correlationId: string;
  traceparent?: string;
  tracestate?: string;
}

/**
 * What an enqueue adds to a payload: the current correlation id, and the W3C
 * trace context when tracing is on. `null` when there is nothing to carry, so
 * a job enqueued outside any request or job is stored exactly as before.
 */
export function jobTraceCarrier(): JobTraceCarrier | null {
  const correlationId = currentCorrelationId();
  if (!enabled) return correlationId ? { correlationId } : null;
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  const traced = headers.traceparent ? traceIdFromTraceparent(headers.traceparent) : null;
  const id = correlationId ?? traced;
  if (!id) return null;
  return {
    correlationId: id,
    ...(headers.traceparent ? { traceparent: headers.traceparent } : {}),
    ...(headers.tracestate ? { tracestate: headers.tracestate } : {}),
  };
}

function traceIdFromTraceparent(value: string): string | null {
  const id = value.split('-')[1];
  return isCorrelationId(id) ? id : null;
}

/**
 * Split a stored payload into the handler's data and the carrier it was
 * enqueued with. A malformed carrier is ignored rather than trusted: the
 * payload is database content, and a correlation id that is not 32 hex
 * characters is not going anywhere near a log line or an audit row.
 */
export function splitJobPayload<T>(data: T): { data: T; carrier: JobTraceCarrier | null } {
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !(JOB_TRACE_KEY in data)) {
    return { data, carrier: null };
  }
  const { [JOB_TRACE_KEY]: raw, ...rest } = data as Record<string, unknown>;
  const candidate = raw as Partial<JobTraceCarrier> | null;
  if (!candidate || !isCorrelationId(candidate.correlationId)) return { data: rest as T, carrier: null };
  return {
    data: rest as T,
    carrier: {
      correlationId: candidate.correlationId,
      ...(typeof candidate.traceparent === 'string' ? { traceparent: candidate.traceparent } : {}),
      ...(typeof candidate.tracestate === 'string' ? { tracestate: candidate.tracestate } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Outbound HTTP
// ---------------------------------------------------------------------------

type FetchLike = (input: string | URL, init?: RequestInit | undefined) => Promise<Response>;

/**
 * Wrap a `guardedFetch` so each request is a CLIENT span when tracing is on.
 *
 * Recorded: method, scheme, host, port and status. NOT recorded: the path and
 * the query, which on a SCIM or Graph call name the person
 * (`/Users?filter=userName eq "jane@acme.test"`, `/users/jane@acme.test`),
 * and no header or body at all.
 *
 * The `traceparent` header is deliberately NOT injected into the request.
 * These are third-party systems -- a customer's HR provider, Microsoft Graph,
 * a SCIM endpoint -- and correlating their side is not worth handing them our
 * internal trace ids; the span already sits under the provisioning run that
 * made the call, which is the correlation this exists for.
 */
export function traceFetch(fetchOnce: FetchLike): FetchLike {
  const traced = async (input: string | URL, init?: RequestInit | undefined): Promise<Response> => {
    if (!enabled) return fetchOnce(input, init);
    let target: URL | null;
    try {
      target = new URL(String(input));
    } catch {
      target = null;
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    return withSpan(
      `HTTP ${method}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': method,
          'url.scheme': target?.protocol.replace(/:$/, ''),
          'server.address': target?.hostname,
          'server.port': target ? Number(target.port || (target.protocol === 'https:' ? 443 : 80)) : undefined,
        },
      },
      async (span) => {
        const response = await fetchOnce(input, init);
        span?.setAttribute('http.response.status_code', response.status);
        if (response.status >= 500) span?.setStatus({ code: SpanStatusCode.ERROR });
        return response;
      },
    );
  };
  return traced;
}

// ---------------------------------------------------------------------------
// Connector operations
// ---------------------------------------------------------------------------

const tracedConnectors = new WeakMap<object, object>();

/**
 * A connector whose every method call is a span named
 * `connector.<family>.<method>`, carrying the family and the method and
 * nothing from the arguments -- which are configs with credentials in them and
 * person records. Returns the connector itself when tracing is off.
 *
 * Handles the three shapes a connector method has: a promise (span until it
 * settles), an async iterable such as `read()` (span until iteration ends),
 * and a plain value (span ends at once).
 */
export function traceConnector<C extends object>(family: string, connector: C): C {
  if (!enabled) return connector;
  const cached = tracedConnectors.get(connector);
  if (cached) return cached as C;
  const proxy = new Proxy(connector, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return function traced(this: unknown, ...args: unknown[]) {
        if (!enabled) return (value as (...a: unknown[]) => unknown).apply(target, args);
        const span = startSpan(`connector.${family}.${property}`, {
          kind: SpanKind.CLIENT,
          attributes: { 'syntra.connector.family': family, 'syntra.connector.operation': property },
        });
        let result: unknown;
        try {
          result = withActiveSpan(span, () => (value as (...a: unknown[]) => unknown).apply(target, args));
        } catch (error) {
          if (span) {
            recordSpanError(span, error);
            span.end();
          }
          throw error;
        }
        if (!span) return result;
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<unknown>).then(
            (settled) => {
              span.end();
              return settled;
            },
            (error: unknown) => {
              recordSpanError(span, error);
              span.end();
              throw error;
            },
          );
        }
        if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
          return traceAsyncIterable(span, result as AsyncIterable<unknown>);
        }
        span.end();
        return result;
      };
    },
  });
  tracedConnectors.set(connector, proxy);
  return proxy;
}

async function* traceAsyncIterable<T>(span: Span, source: AsyncIterable<T>): AsyncGenerator<T> {
  let count = 0;
  try {
    for await (const item of source) {
      count += 1;
      yield item;
    }
  } catch (error) {
    recordSpanError(span, error);
    throw error;
  } finally {
    span.setAttribute('syntra.connector.records', count);
    span.end();
  }
}
