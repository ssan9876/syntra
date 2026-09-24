import type { FastifyServerOptions } from 'fastify';
import {
  activeTraceIds,
  currentCorrelationId,
  LOG_REDACT_PATHS,
  redactValue,
  scrubText,
  serializeError,
} from '@syntra/connectors';
import { serializeRequest } from './request-logging.js';

/** Keys whose value is handled by a serializer below rather than the walker. */
const SERIALIZED_KEYS = new Set(['req', 'res', 'err', 'error']);

/** Where log lines go. A seam for the tests that read them back. */
export interface LogStream {
  write(line: string): void;
}

/**
 * The one logger configuration for this process: the API's request logger,
 * and -- because the scheduler is handed `app.log` -- every background job's.
 * Backlog #56: centralised, so there is no second logger somewhere with the
 * stock pino serializers that copy every property of an error.
 *
 * Four layers, each of which would be enough on a good day:
 *
 *  1. `serializers.err` / `serializers.error`: `serializeError`, which keeps
 *     type, code, status, a scrubbed message and stack and the cause chain,
 *     and PROJECTS the request an HTTP-client error carries to method, URL and
 *     status -- so `error.config.headers.Authorization` never reaches the
 *     output at all. Pino's default copies every enumerable property.
 *  2. `formatters.log`: every logged object walked by `redactValue` -- secret
 *     keys replaced, personal-data keys replaced, strings scrubbed of bearer
 *     tokens, JWTs, PEM blocks, URL credentials and queries, DNs and email
 *     addresses, and the whole bounded in depth, width and length.
 *  3. `hooks.logMethod`: the message string itself scrubbed, for the call that
 *     interpolates an error message into its text.
 *  4. `redact`: pino's own path-based redaction as a last line, applied at
 *     serialisation time to the named paths whatever the layers above did.
 *
 * `mixin` stamps every line with the correlation id of the request or job it
 * was written in and, when tracing is on, the active trace and span ids -- the
 * key an operator uses to go from a log line to the audit events and the trace
 * of the same work.
 *
 * Request logging keeps `serializeRequest` (path without query, method, host,
 * client address): the client address is deliberately retained, see
 * `redact.ts`.
 */
export function loggerOptions(options: { stream?: LogStream | undefined } = {}): NonNullable<FastifyServerOptions['logger']> & object {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    serializers: {
      req: serializeRequest,
      // Cast: Fastify types `err` as returning pino's stock shape with a
      // mandatory `stack`; ours omits it when the error had none.
      err: ((error: unknown) => serializeError(error)) as never,
      error: ((error: unknown) => serializeError(error)) as never,
    },
    formatters: {
      log: (object: Record<string, unknown>) => {
        // The keys that have a serializer are left to it: `req` is a live
        // FastifyRequest here, and walking one generically would both cost a
        // great deal and hand `serializeRequest` something that is no longer
        // a request.
        const passthrough: Record<string, unknown> = {};
        const rest: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(object)) {
          (SERIALIZED_KEYS.has(key) ? passthrough : rest)[key] = value;
        }
        return { ...(redactValue(rest) as Record<string, unknown>), ...passthrough };
      },
    },
    hooks: {
      logMethod(args, method) {
        // pino's call shapes: (msg, ...interp) or (obj, msg, ...interp). Only
        // the string arguments are touched; objects go through `formatters`.
        const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrubText(arg) : arg));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    mixin() {
      const correlationId = currentCorrelationId();
      const trace = activeTraceIds();
      return {
        ...(correlationId ? { correlationId } : {}),
        ...(trace ? { trace_id: trace.traceId, span_id: trace.spanId } : {}),
      };
    },
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
    ...(options.stream ? { stream: options.stream } : {}),
  };
}
