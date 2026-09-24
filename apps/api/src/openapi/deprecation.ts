import type { FastifyInstance } from 'fastify';
import type { DescribedRoute, RouteDeprecation } from './describe.js';
import { toOpenApiPath } from './document.js';

/**
 * The deprecation policy's runtime half: a deprecated operation SAYS so, on
 * every response, not only in a document a client may never reread.
 *
 * `Deprecation` is RFC 9745's structured date (`@<unix seconds>`), `Sunset` is
 * RFC 8594's HTTP-date, and `Link` names the successor when there is one.
 * Generic HTTP tooling — API gateways, client middleware, log alerts — knows
 * these headers already, which is the point of using them rather than a
 * header of our own.
 *
 * `onSend` so the headers go on EVERY answer, including a problem: a caller
 * whose deprecated request is failing is the caller most likely to be reading
 * the response closely. Keyed on the route PATTERN Fastify matched, never the
 * URL, so `/users/123` finds the `/users/:id` entry.
 */
export function registerDeprecationHeaders(
  app: FastifyInstance,
  descriptions: readonly DescribedRoute[],
): void {
  const deprecated = new Map<string, RouteDeprecation>();
  for (const route of descriptions) {
    if (route.deprecated) deprecated.set(`${route.method} ${route.url}`, route.deprecated);
  }
  // Nothing is deprecated today; a hook that can never match is not worth a
  // function call on every response.
  if (deprecated.size === 0) return;

  app.addHook('onSend', async (request, reply) => {
    const entry = deprecated.get(`${request.method} ${request.routeOptions.url}`);
    if (entry === undefined) return;
    for (const [name, value] of Object.entries(deprecationHeaders(entry))) {
      reply.header(name, value);
    }
  });
}

/** The headers a deprecated operation answers with. Pure, for the tests. */
export function deprecationHeaders(entry: RouteDeprecation): Record<string, string> {
  const headers: Record<string, string> = {
    deprecation: `@${Math.floor(Date.parse(`${entry.since}T00:00:00Z`) / 1000)}`,
    sunset: new Date(`${entry.sunset}T00:00:00Z`).toUTCString(),
  };
  if (entry.replacement !== undefined) {
    // As a URI template (`{id}`), the form the published document uses.
    const path = toOpenApiPath(entry.replacement.slice(entry.replacement.indexOf(' ') + 1));
    headers.link = `<${path}>; rel="successor-version"`;
  }
  return headers;
}

/**
 * Whether a deprecation honours the six-month notice docs/api/README.md
 * promises. Checked by `openapi.test.ts`, so a shorter one cannot merge.
 */
export function honoursNoticePeriod(entry: RouteDeprecation): boolean {
  const since = new Date(`${entry.since}T00:00:00Z`);
  const earliest = new Date(since);
  earliest.setUTCMonth(earliest.getUTCMonth() + 6);
  return new Date(`${entry.sunset}T00:00:00Z`).getTime() >= earliest.getTime();
}
