/**
 * Leaves the setup page for the new tenant's sign-in page.
 *
 * A full navigation, not the router: the sign-in page reads the tenant's
 * branding and session on load, and both answered "no tenant" when this page
 * loaded. The address may also be another hostname -- the primary domain the
 * form was given. Its own module because `window.location.assign` is
 * non-configurable in jsdom, so this is the seam the tests replace.
 */
export function goToSignIn(url: string): void {
  const target = new URL(url, window.location.origin);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('The sign-in address must be http or https.');
  }
  window.location.assign(target.toString());
}
