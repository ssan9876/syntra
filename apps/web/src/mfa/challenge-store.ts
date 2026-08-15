export type PendingKind = 'verify' | 'enrol';

export interface PendingChallenge {
  /**
   * 'verify' — present a factor you already hold, at /mfa.
   * 'enrol'  — register one of the required kind, at /enrol.
   * The two screens are separate because the endpoints behind them are
   * separate, and a token issued for one is refused by the other.
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
    if (parsed.kind !== 'verify' && parsed.kind !== 'enrol') return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Where a stored challenge should send the browser. */
export const routeFor = (kind: PendingKind) => (kind === 'enrol' ? '/enrol' : '/mfa');
