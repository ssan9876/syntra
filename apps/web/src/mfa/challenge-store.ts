export type PendingKind = 'verify' | 'enrol' | 'renew';

export interface PendingChallenge {
  /**
   * 'verify' — present a factor you already hold, at /mfa.
   * 'enrol'  — register one of the required kind, at /enrol.
   * 'renew'  — choose a new password, at /renew-password.
   * The screens are separate because the endpoints behind them are separate,
   * and a token issued for one is refused by the others.
   */
  kind: PendingKind;
  attemptToken: string;
  expiresAt: string;
  /** Factors to offer: acceptable ones to verify, or enrollable ones to add. */
  factors: string[];
  /** Where to go once the step-up is satisfied. */
  returnTo: string;
}

const KEY = 'syntra.challenge';

/**
 * sessionStorage rather than a route parameter or React state.
 *
 * The attempt token must survive a full-page navigation (the portal launch
 * path reloads), and it must not end up in a URL, where it would be written to
 * every proxy log and left in the browser's history. sessionStorage is scoped
 * to the tab and cleared when it closes.
 */
export function storeChallenge(challenge: PendingChallenge): void {
  sessionStorage.setItem(KEY, JSON.stringify(challenge));
}

/** Reads and clears in one go: an attempt token is used once. */
export function takeChallenge(): PendingChallenge | null {
  const raw = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingChallenge;
    if (typeof parsed.attemptToken !== 'string') return null;
    if (
      parsed.kind !== 'verify' &&
      parsed.kind !== 'enrol' &&
      parsed.kind !== 'renew'
    ) {
      return null;
    }
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Where a stored challenge should send the browser. */
const ROUTES: Record<PendingKind, string> = {
  verify: '/mfa',
  enrol: '/enrol',
  renew: '/renew-password',
};
export const routeFor = (kind: PendingKind) => ROUTES[kind];

/**
 * A `next` value that may be navigated to, or `/`.
 *
 * Everything that reaches this arrived in a query string, which means it
 * arrived from whoever composed the link. `//evil.test` and `https://evil.test`
 * are both absolute in a browser, so "starts with a slash" is not the check —
 * "starts with exactly one slash" is. A backslash is refused too: some
 * browsers have historically normalized `/\evil.test` to `//evil.test`.
 *
 * The server only ever sends its own paths here. This is the guard for the
 * case where somebody else sends one.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/**
 * Paths this React application does not own.
 *
 * A step-up that began in a SAML, OIDC or upstream-federation flow returns to
 * a *server* route, and `navigate()` would hand it to the router, which owns
 * none of them and would fall through its catch-all to `/`. The user would
 * land on the portal having answered a challenge for a sign-in that then
 * silently never completed.
 */
const SERVER_PATHS = ['/saml/', '/oidc/', '/federation/'];

export const isServerPath = (path: string): boolean =>
  SERVER_PATHS.some((prefix) => path.startsWith(prefix));

/**
 * A challenge the *server* redirected here with, rather than one this
 * application stored on its way out.
 *
 * The JSON endpoints answer the React client, which stores what it was told
 * and navigates. The protocol routes cannot: their caller is a browser
 * mid-redirect, so they carry the same four values in the query string
 * instead. Without this, every SAML, OIDC and upstream step-up landed on
 * "This step expired" one hop after Syntra itself issued the redirect.
 *
 * The token is removed from the address bar by the caller as soon as it has
 * been read — it is a bearer credential, and the browser's history, the
 * `Referer` header and every proxy log are not places to leave one.
 */
export function challengeFromQuery(
  search: string,
  kind: PendingKind,
): PendingChallenge | null {
  const params = new URLSearchParams(search);
  const attemptToken = params.get('attempt');
  if (!attemptToken) return null;
  const expiresAt = params.get('expires') ?? '';
  if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return null;
  const factors = (params.get('factors') ?? '')
    .split(',')
    .map((factor) => factor.trim())
    .filter((factor) => factor !== '');
  if (factors.length === 0) return null;
  return {
    kind,
    attemptToken,
    expiresAt,
    factors,
    returnTo: safeReturnTo(params.get('next')),
  };
}
