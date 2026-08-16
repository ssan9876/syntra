/**
 * Whether a URL may be registered as a protocol endpoint: an assertion
 * consumer service URL, a redirect URI, a post-logout redirect URI, or an
 * upstream single sign-on URL.
 *
 * Stricter than `isLaunchableUrl`, which is about a tile a person clicks.
 * These are addresses a *protocol message* is delivered to, so on top of the
 * http(s) scheme rule two more apply:
 *
 * - No fragment. RFC 6749 section 3.1.2 forbids one on a redirect_uri, and a
 *   SAML ACS URL with a fragment cannot receive an HTTP-POST body at all.
 * - No credentials in the authority. `https://user:pass@sp.test/acs` and
 *   `https://sp.test/acs` are different strings that many SP libraries
 *   normalize to the same request, which is exactly the kind of gap an exact
 *   allowlist exists to close.
 */
export function isProtocolEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.hash !== '' || value.includes('#')) return false;
  if (url.username !== '' || url.password !== '') return false;
  return true;
}

/**
 * Exact string equality against a stored allowlist.
 *
 * Deliberately a plain `includes`, and deliberately not a URL comparison.
 * Spec section 7 says redirect URIs are matched exactly against the registered
 * allowlist, with no wildcard or prefix matching, and every documented
 * open-redirect in an identity product comes from a comparison that was
 * cleverer than this one: a `startsWith` that admits `/acs/../evil`, a
 * case-insensitive host compare that admits a homograph, a parsed comparison
 * that treats a trailing slash as equivalent. Storage normalizes on the way
 * in (Task 17 validates with `isProtocolEndpoint` and stores the string as
 * given); comparison does nothing at all.
 */
export function matchesAllowlist(
  candidate: string,
  allowlist: readonly string[],
): boolean {
  return allowlist.includes(candidate);
}
