import {
  findActiveRestoreHold,
  releaseAllRestoreHolds,
  type RestoreHoldRow,
  type TenantClient,
} from '@syntra/db';

/**
 * A restore nobody has resumed yet.
 *
 * The restore tool inserts one after it puts a backup back. Until it is
 * released the API starts no background work and refuses writes to target
 * systems: a backup from last night carries last night's approved runs and
 * queued jobs, and they must not act on the target systems before somebody has
 * looked at what came back.
 */
export type RestoreHold = RestoreHoldRow;

/**
 * The newest unreleased hold, or null when there is none. Inside a tenant
 * transaction, pass it: the check then reads the same snapshot and takes no
 * second connection.
 */
export function activeRestoreHold(tx?: TenantClient): Promise<RestoreHold | null> {
  return findActiveRestoreHold(tx);
}

/**
 * Releases every unreleased hold. Two restores in a row leave two rows, and
 * resuming after the second must not leave the first holding.
 *
 * Returns how many were released; zero means another administrator got there
 * first.
 */
export function releaseRestoreHolds(now: Date = new Date()): Promise<number> {
  return releaseAllRestoreHolds(now);
}

/** The reason given when a write to a target system is refused by a hold. */
export function restoreHoldReason(hold: RestoreHold): string {
  return `restored from ${hold.backupName} and not resumed yet`;
}

/**
 * Resolves once no hold is active. Polls, because the release can happen in
 * another replica.
 *
 * A failed check counts as held: starting background work over a database
 * that could not say whether it was just restored is the failure this exists
 * to prevent. The next poll tries again.
 */
export async function waitForRestoreRelease(options: {
  intervalMs?: number;
  signal?: AbortSignal;
  check?: () => Promise<RestoreHold | null>;
  onHeld?: (hold: RestoreHold | null, err?: unknown) => void;
} = {}): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 15_000;
  const check = options.check ?? (() => activeRestoreHold());
  let reported = false;
  for (;;) {
    if (options.signal?.aborted) return false;
    try {
      const hold = await check();
      if (!hold) return true;
      if (!reported) options.onHeld?.(hold);
      reported = true;
    } catch (err) {
      options.onHeld?.(null, err);
    }
    const woke = await sleep(intervalMs, options.signal);
    if (!woke) return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
