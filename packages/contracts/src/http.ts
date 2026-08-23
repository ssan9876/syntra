/**
 * The URL prefixes the SERVER owns, as opposed to the single-page application.
 *
 * Two things need this list and must never disagree about it:
 *
 *  - the development proxy, which forwards these to the API and serves
 *    everything else from Vite;
 *  - the production fallback, which serves `index.html` for everything else
 *    and must leave these alone.
 *
 * They have already disagreed once. `/saml`, `/oidc` and `/federation` were
 * missing from the proxy, so a SAML tile opened `/saml/start/:id`, Vite served
 * the application, the router owned no such path and its catch-all redirected
 * to `/`. No error anywhere — the tile simply appeared to do nothing.
 *
 * The failure is worse in the other direction. A fallback that swallowed
 * `/api` would answer a mistyped or removed endpoint with 200 and a page of
 * HTML, and every client parsing that as JSON would report a syntax error
 * instead of a 404. One list, imported by both, is the only way this stays
 * true as prefixes are added.
 */
export const SERVER_PATH_PREFIXES = [
  '/api',
  '/saml',
  '/oidc',
  '/federation',
  '/health',
] as const;

/**
 * Whether a pathname belongs to the server rather than the application.
 *
 * Matches a prefix only at a segment boundary: `/apiary` is a page the
 * application may own one day, and treating it as the API because it starts
 * with those four letters would be a bug nobody would find quickly.
 */
export function isServerPath(pathname: string): boolean {
  return SERVER_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
