/**
 * Leaves this single-page application for a path the *server* owns.
 *
 * `/saml/...`, `/oidc/...` and `/federation/...` are Fastify routes. Handing
 * one to react-router's `navigate()` matches nothing, falls through the
 * catch-all, and lands the user on the portal — with the service provider's
 * sign-in silently abandoned mid-flight, which is indistinguishable from
 * "the tile did nothing".
 *
 * Its own module because `window.location.assign` is non-configurable in
 * jsdom, so this is the seam the browser tests replace. One line, one place,
 * and the thing it guards is a failure with no error message anywhere.
 */
export function leaveTo(url: string): void {
  window.location.assign(url);
}
