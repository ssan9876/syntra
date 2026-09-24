import { disableTracing, enableTracing } from '@syntra/connectors';

/**
 * Optional OpenTelemetry tracing (backlog #55).
 *
 * OFF unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and off when
 * `OTEL_SDK_DISABLED=true` whatever else is. Off means: the SDK packages are
 * never imported (the `import()`s below are dynamic for exactly that reason),
 * no provider is registered, `@opentelemetry/api` stays a no-op, and every
 * `withSpan`/`traceConnector`/`traceFetch` call site checks one boolean and
 * calls straight through. The always-on correlation id is independent of all
 * of this.
 *
 * On means: a `NodeTracerProvider` with the AsyncLocalStorage context manager
 * and W3C trace-context propagation, a batching OTLP/HTTP exporter, and
 * spans for
 *
 *  - every HTTP request (`plugins/tracing.ts`: method, route pattern,
 *    status, tenant id);
 *  - every pg-boss job, parented on the request or job that enqueued it
 *    through the payload's `_syntraTrace` carrier (`jobs/scheduler.ts`), so
 *    an HR import, the provisioning run it causes and that run's connector
 *    calls are one trace;
 *  - every connector operation (`connector.<family>.<method>`) and every
 *    outbound HTTP request made through `guardedFetch` (method, host, status);
 *  - optionally, every Prisma operation (`SYNTRA_OTEL_DATABASE=true`), which
 *    is off by default because it multiplies span volume many times over.
 *    Prisma's spans carry the parameterised SQL, never parameter values.
 *
 * The standard exporter variables are honoured as the OpenTelemetry
 * specification defines them -- `OTEL_EXPORTER_OTLP_HEADERS` for a vendor's
 * API key, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to override the path,
 * `OTEL_TRACES_SAMPLER`/`OTEL_TRACES_SAMPLER_ARG` for sampling,
 * `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` for identity.
 *
 * Must run BEFORE `buildApp`: the HTTP hooks decide at registration whether
 * to install their span handling, and Prisma instrumentation has to be in
 * place before the first query.
 */
export interface Telemetry {
  enabled: boolean;
  /** Flush buffered spans and stop exporting. Safe to call when disabled. */
  shutdown(): Promise<void>;
}

const DISABLED: Telemetry = { enabled: false, shutdown: async () => undefined };

export function tracingConfigured(env: NodeJS.ProcessEnv): boolean {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return false;
  return env.OTEL_SDK_DISABLED?.trim().toLowerCase() !== 'true';
}

export async function startTelemetry(
  env: NodeJS.ProcessEnv,
  options: { version: string; log?: (message: string) => void } = { version: 'unknown' },
): Promise<Telemetry> {
  if (!tracingConfigured(env)) return DISABLED;

  const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes, detectResources, envDetector }] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
    ]);

  const resource = resourceFromAttributes({
    'service.name': env.OTEL_SERVICE_NAME?.trim() || 'syntra-api',
    'service.version': options.version,
  }).merge(detectResources({ detectors: [envDetector] }));

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  // Registers the global tracer provider, the AsyncLocalStorage context
  // manager and the W3C trace-context + baggage propagators.
  provider.register();

  if (env.SYNTRA_OTEL_DATABASE?.trim().toLowerCase() === 'true') {
    // Constructed AFTER `register()`: the instrumentation picks up the global
    // provider when it enables itself, which its constructor does.
    const { PrismaInstrumentation } = await import('@prisma/instrumentation');
    new PrismaInstrumentation();
  }

  enableTracing();

  // Only the host: the endpoint URL may carry a token in its path or query,
  // and the headers variable certainly does.
  let host = 'the configured endpoint';
  try {
    host = new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT!.trim()).host;
  } catch {
    // An unparseable endpoint is the exporter's to report.
  }
  options.log?.(`OpenTelemetry tracing enabled; exporting OTLP/HTTP to ${host}`);

  return {
    enabled: true,
    async shutdown() {
      disableTracing();
      await provider.shutdown();
    },
  };
}
