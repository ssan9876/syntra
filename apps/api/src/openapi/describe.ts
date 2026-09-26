import type { ZodTypeAny } from 'zod';

/**
 * What a person has to write down about a route for it to be published.
 *
 * Deliberately SMALL, and deliberately missing the things the server already
 * knows. The method, the full URL, the permission it checks, whether a machine
 * token may call it and its rate limit all come from the running route table
 * (`route-catalog.ts`), so none of them can be written here and then drift
 * from what is enforced. What is left is what only a person can say — what
 * the operation is for — and the contracts schemas the handler already parses
 * with, referenced rather than restated.
 */
export interface RouteDescription {
  /** One line, imperative, no trailing period: "List roles". */
  summary: string;
  /** Longer prose, CommonMark. Optional; most operations need none. */
  description?: string;
  /** The schema the handler parses `request.body` with. */
  body?: ZodTypeAny;
  /** The schema the handler parses `request.query` with. */
  query?: ZodTypeAny;
  /**
   * The schema the handler parses `request.params` with. Left out, every path
   * parameter is described as a plain string, which is true of all of them;
   * the schema only adds formats such as `uuid`.
   */
  params?: ZodTypeAny;
  /**
   * The schema of a successful response body, where contracts has one. Most
   * routes do not yet — see docs/configure.md (The administration API) — and are published as "a JSON
   * object" rather than with a schema invented for the document.
   */
  response?: ZodTypeAny;
  /** The success status. Defaults to 200; 204 publishes no response body. */
  status?: 200 | 201 | 202 | 204;
  /**
   * The media type of a success that is not JSON — a CSV export, a PDF
   * evidence pack, a metadata XML document.
   */
  produces?: string;
  /**
   * Marks the operation deprecated — see the policy in docs/configure.md (The administration API).
   *
   * Not a bare flag, because a deprecation is a promise with a date on it.
   * Setting this publishes `deprecated: true` in the document AND makes every
   * response from the route carry `Deprecation` and `Sunset` headers
   * (`deprecation.ts`), so a client that never rereads the document still
   * hears about it. `openapi.test.ts` refuses a sunset less than six months
   * after the deprecation.
   */
  deprecated?: RouteDeprecation;
}

export interface RouteDeprecation {
  /** When it was deprecated, `YYYY-MM-DD` (UTC). */
  since: string;
  /** The earliest it may be removed, `YYYY-MM-DD` (UTC). */
  sunset: string;
  /** What to call instead, as `'METHOD /api/admin/…'`, when there is one. */
  replacement?: string;
}

export interface DescribedRoute extends RouteDescription {
  method: string;
  /** The full Fastify pattern, prefix included: `/api/admin/roles/:id`. */
  url: string;
  tag: string;
  /**
   * An unauthenticated route: no session, no token, the tenant resolved from
   * the hostname. Published with no security requirement, so a client
   * generator does not attach credentials to a call that must not carry them.
   */
  public?: true;
}

/**
 * The same, for routes OUTSIDE `/api/admin` that anybody may call -- the
 * handful an integrator or a person with a link reaches without signing in.
 * Keyed by the full path, because there is no shared prefix to hang them on.
 */
export function describePublicRoutes(
  tag: string,
  routes: Record<string, RouteDescription>,
): DescribedRoute[] {
  return Object.entries(routes).map(([key, description]) => {
    const space = key.indexOf(' ');
    return {
      ...description,
      method: key.slice(0, space),
      url: key.slice(space + 1),
      tag,
      public: true as const,
    };
  });
}

/**
 * One route module's descriptions, keyed `'METHOD /path'` with the path as the
 * module writes it — relative to the `/api/admin` prefix it is mounted under —
 * so the key can be found by searching the route file for the same string.
 */
export function describeAdminRoutes(
  tag: string,
  routes: Record<string, RouteDescription>,
): DescribedRoute[] {
  return Object.entries(routes).map(([key, description]) => {
    const space = key.indexOf(' ');
    const method = key.slice(0, space);
    const path = key.slice(space + 1);
    return { ...description, method, url: `/api/admin${path}`, tag };
  });
}
