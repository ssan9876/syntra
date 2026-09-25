import type { FastifyInstance } from 'fastify';
import type { CatalogRoute } from './route-catalog.js';
import { buildOpenApiDocument } from './document.js';
import { ROUTE_DESCRIPTIONS } from './descriptions.js';
import { registerDeprecationHeaders } from './deprecation.js';

export const OPENAPI_PATH = '/api/openapi.json';

/**
 * `GET /api/openapi.json` — the published description, served by the thing
 * it describes.
 *
 * UNAUTHENTICATED, on purpose: an integrator generating a client has no
 * credential yet, and the document holds nothing a caller could not learn by
 * reading the open-source repository. It is also outside tenant resolution
 * (`UNSCOPED_PATHS`), because it is identical for every tenant — built from the
 * route table and the descriptions, never from a database row. Nothing
 * tenant-specific can end up in it, because nothing tenant-specific is an
 * input.
 *
 * Built ONCE, on the first request, not at registration: routes registered
 * after this one (every admin plugin) would be missing from a document built
 * any earlier. The catalog is complete by the time the server answers
 * anything.
 *
 * Rate-limited like `/health/ready`, per address: the answer is a cached
 * string, but an unauthenticated route with no limit at all is still an
 * invitation.
 */
export function registerOpenApiRoute(app: FastifyInstance, catalog: CatalogRoute[]): void {
  // On the root instance, before any admin plugin registers, so the hook
  // reaches every route a description can name.
  registerDeprecationHeaders(app, ROUTE_DESCRIPTIONS);

  let serialized: string | null = null;
  app.get(
    OPENAPI_PATH,
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      serialized ??= serializeOpenApiDocument(catalog);
      return reply
        .type('application/json; charset=utf-8')
        // Short, because a deployment's document changes with its release.
        .header('cache-control', 'public, max-age=300')
        .send(serialized);
    },
  );
}

/**
 * The document as bytes, exactly as `pnpm openapi:generate` commits it — two
 * spaces, trailing newline — so the served copy and the committed copy of the
 * same build are byte-identical, and a diff between them means a real change.
 */
export function serializeOpenApiDocument(catalog: readonly CatalogRoute[]): string {
  return `${JSON.stringify(buildOpenApiDocument(catalog, ROUTE_DESCRIPTIONS), null, 2)}\n`;
}
