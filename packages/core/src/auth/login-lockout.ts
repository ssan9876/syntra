import type { TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';

/**
 * Account lockout: the control that protects an account, as distinct from the
 * rate limit that protects the service.
 *
 * The two are routinely confused and neither substitutes for the other. A
 * rate limit keyed on the caller's address is spent by one attacker and
 * refills a minute later; it bounds how fast guesses arrive, not how many an
 * account will tolerate. Lockout bounds the second number, which is the one
 * that decides whether a weak password is eventually guessed.
 *
 * Off by default. Switching lockout on for a tenant that never asked for it
 * is how the first administrator meets the feature from the wrong side of it.
 */
export interface LockoutPolicy {
  threshold: number;
  windowMinutes: number;
  durationMinutes: number;
}

export interface LockoutState {
  failedCount: number;
  firstFailedAt: Date;
  lockedAt: Date | null;
  lockedUntil: Date | null;
}

const MINUTE = 60_000;

/**
 * Whether a stored row amounts to a live lock at `now`.
 *
 * Takes only the two fields it reads, so a caller listing a page of users can
 * select those two rather than whole rows.
 */
export function isLocked(
  state: Pick<LockoutState, 'lockedAt' | 'lockedUntil'> | null,
  now: Date,
): boolean {
  if (state === null || state.lockedAt === null) return false;
  // A null `lockedUntil` is a lock that does not lift itself. Reading it as
  // "no expiry recorded, so not locked" would turn the strictest setting into
  // the weakest one.
  if (state.lockedUntil === null) return true;
  return now < state.lockedUntil;
}

/**
 * The same question as `isLocked`, asked of the database instead of a row.
 *
 * Here so that counting locked accounts does not mean reading every lockout
 * row into the process and filtering it in JavaScript, which is what the
 * directory's stat card did -- client-side counting over a whole collection,
 * one layer below the route that had just stopped doing exactly that.
 *
 * Beside `isLocked` and mirroring it clause for clause, deliberately: two
 * definitions of "locked" that drift apart would show a number no page could
 * be filtered to reproduce.
 */
export function lockedWhere(now: Date) {
  return {
    lockedAt: { not: null },
    OR: [{ lockedUntil: null }, { lockedUntil: { gt: now } }],
  };
}

/**
 * Reads the lock, if any, for a user who has already been resolved.
 *
 * Never called for an unknown login — see `recordFailure`.
 */
export async function readLockout(
  tx: TenantClient,
  userId: string,
): Promise<LockoutState | null> {
  return tx.loginLockout.findUnique({
    where: { userId },
    select: {
      failedCount: true,
      firstFailedAt: true,
      lockedAt: true,
      lockedUntil: true,
    },
  });
}

/**
 * Counts one failed password against an account and locks it if that reaches
 * the threshold.
 *
 * Only ever called for a login that resolved to a real user. A row per
 * invented name would make this table an oracle for which logins exist, and
 * would let anybody grow it without bound.
 */
export async function recordFailure(
  tx: TenantClient,
  input: {
    tenantId: string;
    userId: string;
    login: string;
    sourceIp: string | null;
    policy: LockoutPolicy;
    now: Date;
  },
): Promise<void> {
  const { policy, now, userId } = input;
  if (policy.threshold <= 0) return;

  // `tx` is always inside its own transaction (`withTenant` / `request.db`
  // open one per call), so this advisory lock is released automatically on
  // commit or rollback. It serialises every recordFailure for this one user
  // — a second, concurrent call blocks here until the first has committed —
  // which is what turns the read-then-upsert below from a lost-update race
  // into an atomic increment, without hand-rolling the window/threshold
  // branching a second time as one large CASE-laden raw upsert.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

  const existing = await readLockout(tx, userId);

  // A run of failures is measured from its first, not its most recent: a
  // steady drip one minute inside the window every time would otherwise hold
  // the window open forever and lock an account that nobody is attacking.
  const runExpired =
    existing !== null &&
    now.getTime() - existing.firstFailedAt.getTime() >= policy.windowMinutes * MINUTE;

  // A failure arriving against a lock that has already lifted starts a fresh
  // run too, rather than landing on top of the count that produced the lock.
  const continuing = existing !== null && !runExpired && !isLocked(existing, now);

  const failedCount = continuing ? existing.failedCount + 1 : 1;
  const firstFailedAt = continuing ? existing.firstFailedAt : now;

  if (isLocked(existing, now)) {
    // Already locked. Record that somebody is still trying, but do not extend
    // the lock — an attacker who keeps guessing would otherwise hold a real
    // user out indefinitely.
    await tx.loginLockout.update({
      where: { userId },
      data: { lastFailedAt: now },
    });
    return;
  }

  const reached = failedCount >= policy.threshold;
  const lockedAt = reached ? now : null;
  const lockedUntil =
    reached && policy.durationMinutes > 0
      ? new Date(now.getTime() + policy.durationMinutes * MINUTE)
      : null;

  await tx.loginLockout.upsert({
    where: { userId },
    create: {
      tenantId: input.tenantId,
      userId,
      failedCount,
      firstFailedAt,
      lastFailedAt: now,
      lockedAt,
      lockedUntil,
    },
    update: { failedCount, firstFailedAt, lastFailedAt: now, lockedAt, lockedUntil },
  });

  if (reached) {
    await recordEvent(tx, {
      actorUserId: userId,
      action: 'auth.lockout',
      targetType: 'User',
      targetId: userId,
      outcome: 'failure',
      sourceIp: input.sourceIp,
      payload: {
        login: input.login,
        failedCount,
        // Null says "until an administrator lifts it", which is the fact the
        // person reading this row needs.
        lockedUntil: lockedUntil?.toISOString() ?? null,
      },
    });
  }
}

/**
 * Forgets the failures against an account. Called when its password is
 * accepted, and by an administrator lifting a lock by hand.
 *
 * A delete rather than a reset to zero: absent is the ordinary state, and the
 * table should stay the size of the problem rather than the size of the
 * directory.
 */
export async function clearLockout(tx: TenantClient, userId: string): Promise<void> {
  await tx.loginLockout.deleteMany({ where: { userId } });
}
