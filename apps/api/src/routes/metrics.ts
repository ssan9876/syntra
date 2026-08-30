import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Registry, collectDefaultMetrics, Gauge, Histogram } from '@prometheus-io/client';
import { buildInfo } from '@syntra/core';

export interface MetricsRouteOptions {
  /** Null means the route is never registered. */
  token: string | null;
}

/**
 * Constant-time, and length-safe.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal and a 500. Comparing lengths first and returning early is not
 * a leak worth caring about — the length of a token an operator configured is
 * not the secret — but throwing would be.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The metrics this process holds in memory.
 *
 * A registry of its own rather than the library's global one, so a test can
 * build two apps in one process without their series bleeding together.
 */
export interface MetricsHandles {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
}

function buildRegistry(): MetricsHandles {
  const registry = new Registry();

  // Heap, CPU, event-loop lag, handles. These are what somebody actually wants
  // when the API is slow, and hand-rolling an event-loop lag histogram to save
  // a dependency would be the wrong trade in an auth product.
  collectDefaultMetrics({ register: registry, prefix: 'syntra_' });

  new Gauge({
    name: 'syntra_build_info',
    help: 'The running version, as a label on a constant 1.',
    labelNames: ['version'],
    registers: [registry],
  }).set({ version: buildInfo().version }, 1);

  const httpDuration = new Histogram({
    name: 'syntra_http_request_duration_seconds',
    help: 'Request duration by route pattern.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  return { registry, httpDuration };
}

/**
 * `GET /metrics`, or nothing at all.
 *
 * With no token configured this registers NOTHING — no route, no hook, no
 * registry. An installation that never opted in answers 404, which is the
 * point: a route answering 403 would confirm its own existence, and the
 * existence of a metrics endpoint tells somebody probing what this deployment
 * is and how it is operated.
 *
 * No label anywhere carries a tenant id, a tenant slug, or a uuid from a URL.
 * Every series is installation-wide, so a scrape cannot enumerate customers or
 * count them, and cardinality does not grow with them — which is the ordinary
 * way a Prometheus instance is brought down by its own success. An operator
 * debugging one tenant has the audit log and the console, both authenticated
 * and both better at it than a time series.
 */
export async function registerMetricsRoutes(
  app: FastifyInstance,
  options: MetricsRouteOptions,
): Promise<void> {
  const token = options.token;
  if (token === null) return;

  const { registry, httpDuration } = buildRegistry();

  app.addHook('onResponse', async (request, reply) => {
    // `routeOptions.url` is Fastify's REGISTERED PATTERN --
    // `/api/admin/users/:id/sessions` -- and never `request.url`. A raw URL
    // would put user ids and tenant hostnames into label values: unbounded
    // cardinality and a disclosure in one move, and a 404 for a scanned path
    // would let anybody mint a new series per probe.
    const route = request.routeOptions?.url ?? 'unrouted';
    httpDuration.observe(
      {
        method: request.method,
        route,
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get(
    '/metrics',
    {
      // The same limit `/health/ready` carries, for the same reason: this
      // endpoint is not free and is reachable with one credential.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const header = request.headers.authorization;
      const presented = header?.startsWith('Bearer ') ? header.slice(7) : null;

      // Absent, malformed and wrong all take the same exit with the same body.
      // Telling them apart would say whether a token was the right shape.
      if (presented === null || !tokenMatches(presented, token)) {
        return reply.code(401).send();
      }

      return reply
        .header('content-type', registry.contentType)
        .send(await registry.metrics());
    },
  );
}
