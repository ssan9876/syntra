import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  extractContext,
  isCorrelationId,
  newCorrelationId,
  recordSpanError,
  SpanKind,
  startSpan,
  traceIdOf,
  tracingEnabled,
  withActiveSpan,
  withCorrelation,
} from '@syntra/connectors';
import { SpanStatusCode, type Span } from '@opentelemetry/api';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The id every log line, audit event and job this request causes will
     * carry. The trace id when tracing is on; a random id of the same shape
     * when it is off. Returned to the caller in `x-correlation-id`.
     */
    correlationId: string;
  }
}

const SPAN = Symbol('syntra.span');

type TracedRequest = FastifyRequest & { [SPAN]?: Span | null };

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Correlation for every request and, when tracing is on, a SERVER span.
 *
 * WHY TWO HOOKS. The span starts in `onRequest`, so its duration covers the
 * whole request. The async context -- the correlation id in
 * `AsyncLocalStorage` and the active span -- is entered in `preValidation`,
 * because a context entered in `onRequest` does not survive body parsing:
 * the parser resumes on the socket's `data` events, which belong to the
 * connection and not to the request, and a POST handler would run with no
 * correlation id at all. `@fastify/request-context` learned the same thing.
 * Nothing between the two hooks writes an audit event or enqueues a job.
 *
 * WHAT A SPAN CARRIES: method, the ROUTE PATTERN (`/api/admin/users/:id`,
 * never the URL -- the same rule, and the same reason, as the metrics label),
 * status and the tenant id. Not the query, not a header, not the client
 * address, not the user agent. An error is recorded as its type and a scrubbed
 * message (`recordSpanError`).
 *
 * An incoming `traceparent` is honoured only when tracing is on, which is the
 * standard behaviour and lets a load balancer or a calling service join its
 * trace. With tracing off the id is always minted here: nothing a client sends
 * becomes a correlation id in the audit table unless an operator turned
 * tracing on.
 */
export function registerTracing(app: FastifyInstance): void {
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', (request: TracedRequest, reply, done) => {
    let span: Span | null = null;
    if (tracingEnabled()) {
      span = startSpan(request.method, {
        kind: SpanKind.SERVER,
        parent: extractContext(request.headers as Record<string, unknown>),
        attributes: {
          'http.request.method': request.method,
          'url.scheme': request.protocol,
        },
      });
    }
    request[SPAN] = span;
    const traceId = traceIdOf(span);
    request.correlationId = traceId ?? newCorrelationId();
    reply.header(CORRELATION_HEADER, request.correlationId);
    done();
  });

  app.addHook('preValidation', (request: TracedRequest, _reply, done) => {
    const id = isCorrelationId(request.correlationId) ? request.correlationId : newCorrelationId();
    withActiveSpan(request[SPAN] ?? null, () => withCorrelation(id, () => done()));
  });

  if (!tracingEnabled()) return;

  app.addHook('onError', async (request: TracedRequest, _reply, error) => {
    const span = request[SPAN];
    if (span) recordSpanError(span, error);
  });

  app.addHook('onResponse', async (request: TracedRequest, reply) => {
    const span = request[SPAN];
    if (!span) return;
    const route = request.routeOptions?.url ?? 'unrouted';
    span.updateName(`${request.method} ${route}`);
    span.setAttribute('http.route', route);
    span.setAttribute('http.response.status_code', reply.statusCode);
    if (typeof request.tenantId === 'string' && request.tenantId !== '') {
      span.setAttribute('syntra.tenant_id', request.tenantId);
    }
    if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
}
