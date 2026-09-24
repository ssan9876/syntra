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
/**
 * Converts an untrusted return target into a same-origin server path.
 *
 * Protocol continuations are relative paths by contract. Parsing first and
 * comparing origins makes scheme-relative URLs (`//evil.example`) and
 * executable schemes impossible even if a future caller forgets the earlier
 * challenge-store validation.
 */
export function sameOriginServerPath(url: string, origin = window.location.origin): string {
  if (!url.startsWith('/') || url.startsWith('//')) {
    throw new Error('The return target must be a same-origin server path.');
  }

  const parsed = new URL(url, origin);
  if (parsed.origin !== origin || parsed.username !== '' || parsed.password !== '') {
    throw new Error('The return target must stay on this origin.');
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function leaveTo(url: string): void {
  window.location.assign(sameOriginServerPath(url));
}
