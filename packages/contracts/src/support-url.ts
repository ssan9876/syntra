// No imports, on purpose -- the same reason as `launchable-url.ts`: the web
// bundle imports this file directly, and reaching it through the package index
// would drag every zod schema onto the sign-in page.

/**
 * Whether a URL is somewhere the sign-in page and the portal may send a person
 * who needs help: an `https:` page (the service desk, a status page) or a
 * `mailto:` address.
 *
 * Deliberately narrower than `isLaunchableUrl`. This link is rendered on the
 * UNAUTHENTICATED sign-in page, where anybody who can reach the hostname sees
 * it, so `javascript:` and `data:` are stored XSS and plain `http:` is a help
 * page an on-path attacker can swap for a phishing form -- on the one screen
 * that asks for a password. `tel:` is left out not because it is dangerous but
 * because nobody has asked, and a scheme is easier to add than to withdraw.
 *
 * Exported so every sink re-checks it: the admin API on the way in, the
 * service on write, and the page on render. A row can predate this check.
 */
export function isSupportUrl(value: string): boolean {
  // Control characters and whitespace are refused outright rather than left to
  // the URL parser, which silently strips some of them -- a value that parses
  // to something other than what was stored is not one to render.
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.hostname !== '';
    if (url.protocol === 'mailto:') return /^[^@/]+@[^@/]+$/.test(decodeURIComponent(url.pathname));
    return false;
  } catch {
    return false;
  }
}
