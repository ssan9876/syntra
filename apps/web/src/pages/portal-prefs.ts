import { useCallback, useEffect, useState } from 'react';

/**
 * What one person pinned, and what they opened last, on THIS browser.
 *
 * Browser storage and not the server, deliberately. Both are conveniences
 * that shape one screen, and neither is worth a table, a migration and an
 * endpoint — nor worth following somebody to a shared ward PC, where the next
 * person to sign in is somebody else entirely. Keyed per user id for exactly
 * that PC: two nurses on one browser do not see each other's pins.
 *
 * Every access is wrapped. Storage throws in a private window, under a strict
 * policy, or when full, and a portal that fails to render because a shortcut
 * could not be remembered has its priorities backwards — the tiles still
 * work, the row above them simply does not appear.
 */

/** "About four": a short row of shortcuts, not a history. */
export const RECENT_LIMIT = 4;

/**
 * Remembered: twice what is shown. The row leaves out what is already pinned
 * and what has since been unassigned, and remembering only four would leave it
 * short after the first pin.
 */
const RECENT_STORED = RECENT_LIMIT * 2;

const pinnedKey = (userId: string) => `syntra.portal.pinned.${userId}`;
const recentKey = (userId: string) => `syntra.portal.recent.${userId}`;

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything else in that slot — an older shape, a hand edit — is treated
    // as nothing rather than trusted into the render.
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function write(key: string, value: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The change still applies for this visit; it is only not remembered.
  }
}

export function usePortalPrefs(userId: string | undefined) {
  const [pinned, setPinned] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);

  // Re-read when the user changes, not once: a session that resolves after
  // the first render would otherwise leave the rows empty for the visit.
  useEffect(() => {
    if (!userId) return;
    setPinned(read(pinnedKey(userId)));
    setRecent(read(recentKey(userId)));
  }, [userId]);

  const togglePin = useCallback(
    (tileId: string) => {
      setPinned((current) => {
        // Appended, not prepended: a row whose order shifts every time
        // something is pinned is a row nobody can learn by position.
        const next = current.includes(tileId)
          ? current.filter((id) => id !== tileId)
          : [...current, tileId];
        if (userId) write(pinnedKey(userId), next);
        return next;
      });
    },
    [userId],
  );

  const recordLaunch = useCallback(
    (tileId: string) => {
      setRecent((current) => {
        const next = [tileId, ...current.filter((id) => id !== tileId)].slice(0, RECENT_STORED);
        if (userId) write(recentKey(userId), next);
        return next;
      });
    },
    [userId],
  );

  return { pinned, recent, togglePin, recordLaunch };
}
