// No imports, on purpose. The console bundles this file directly, and
// reaching it through the package index would pull every zod schema in the
// contracts package into the page that needs one twelve-line function.

/**
 * Whether a URL is an http(s) launch target the portal may send a browser to.
 *
 * `z.string().url()` alone is not enough: the WHATWG URL parser accepts any
 * scheme, so `javascript:alert(1)` passes it as happily as
 * `https://crm.acme.test/`. This is the URL the portal navigates a signed-in
 * user's browser to when they click the tile, so an unrestricted scheme is a
 * stored XSS vector, not just a validation nicety. Bookmarks only ever launch
 * over the web, so http(s) is the whole legitimate set.
 *
 * Exported so the launch route can re-check it on the way out, not just the
 * admin API on the way in — a row can predate this check (an older
 * migration, a seed script, a restore from before it existed), and trusting
 * storage because a schema exists somewhere is exactly the gap that lets a
 * stale `javascript:` URL reach a browser.
 */
export function isLaunchableUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
