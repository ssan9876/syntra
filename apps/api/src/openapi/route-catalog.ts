import type { FastifyInstance, RouteOptions } from 'fastify';
import { permissionsOfGuard } from '../plugins/require-permission.js';
import { routeRefusesTokens } from '../plugins/bearer-token.js';

/**
 * One route as the running server registered it.
 *
 * Everything here is OBSERVED, never declared: the method and URL are what
 * Fastify was handed, the permissions are read off the guards in the route's
 * own `preHandler` list, and whether a machine token may call it is the same
 * `routeRefusesTokens` answer `requireSession` gives at request time. The
 * OpenAPI description layers prose and request schemas on top of this; it
 * never restates any of it. See `document.ts`.
 */
export interface CatalogRoute {
  method: string;
  /** Fastify's pattern, `/api/admin/roles/:id` — not the OpenAPI `{id}` form. */
  url: string;
  /**
   * Every permission a `requirePermission` guard on this route demands, in
   * registration order. ALL of them are required: Fastify runs every
   * `preHandler`, and each guard throws on its own.
   */
  permissions: string[];
  /** False for a route `TOKEN_DENIED_ROUTES` refuses a bearer token at. */
  tokenAllowed: boolean;
  /** The per-route `@fastify/rate-limit` setting, when the route has one. */
  rateLimit: { max: number | string; timeWindow: string | number } | null;
}

/**
 * The route table, captured as it is built.
 *
 * An `onRoute` hook on the ROOT instance, added before any plugin registers a
 * route: Fastify runs a root `onRoute` hook for routes declared inside every
 * plugin registered after it, so this sees the whole application, including
 * the prefix each plugin was mounted under.
 *
 * Fastify has no "list the routes" API that returns structured options —
 * `printRoutes()` is a drawing for a person — so recording at registration is
 * the only way to get a table a test can assert over.
 *
 * `HEAD` is skipped: Fastify adds one beside every `GET` on its own
 * (`exposeHeadRoutes`), and documenting it would double the document without
 * telling a client anything.
 */
export function captureRouteCatalog(app: FastifyInstance): CatalogRoute[] {
  const routes: CatalogRoute[] = [];
  app.addHook('onRoute', (options: RouteOptions) => {
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    const handlers = options.preHandler === undefined
      ? []
      : Array.isArray(options.preHandler)
        ? options.preHandler
        : [options.preHandler];
    const permissions = [...new Set(handlers.flatMap((handler) => permissionsOfGuard(handler)))];
    const limit = (options.config as { rateLimit?: { max?: number | string; timeWindow?: string | number } } | undefined)
      ?.rateLimit;
    const url = options.url;
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push({
        method,
        url,
        permissions,
        tokenAllowed: !routeRefusesTokens(url, method),
        rateLimit:
          limit && limit.max !== undefined
            ? { max: limit.max, timeWindow: limit.timeWindow ?? '1 minute' }
            : null,
      });
    }
  });
  return routes;
}
