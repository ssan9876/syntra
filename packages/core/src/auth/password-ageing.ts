import type { TenantClient } from '@syntra/db';

import { verifyPassword } from './password.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Password ageing, in two halves that are deliberately independent settings.
 *
 * **Reuse prevention** (`passwordHistoryDepth`) is the half worth switching
 * on. It costs a user nothing until the moment they try to put a password
 * they already retired back into service.
 *
 * **Scheduled expiry** (`passwordMaxAgeDays`) is the half that is off by
 * default and should usually stay off. NIST SP 800-63B stopped recommending
 * it years ago, and for a reason this codebase should state rather than
 * inherit: a person required to choose a new password every ninety days picks
 * one they can iterate, and `Summer2026!` becomes `Autumn2026!`. It is
 * implemented because organizations are audited against policies that still
 * demand it, not because turning it on makes a tenant safer.
 */
export interface AgeingPolicy {
  passwordMaxAgeDays: number;
  passwordHistoryDepth: number;
}

/**
 * Whether this user must choose a new password before they get a session.
 *
 * Answers false for anything Syntra does not own. A user whose password lives
 * upstream cannot be helped by a change form here — expiring them would strand
 * them in front of a screen that changes nothing at their provider — and a
 * user with no password credential at all has nothing to age.
 */
export async function passwordExpired(
  tx: TenantClient,
  userId: string,
  policy: AgeingPolicy,
  now: Date,
): Promise<boolean> {
  if (policy.passwordMaxAgeDays <= 0) return false;

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { passwordSource: true },
  });
  if (!user || user.passwordSource !== 'local') return false;

  const credential = await tx.passwordCredential.findUnique({
    where: { userId },
    select: { changedAt: true },
  });
  if (!credential) return false;

  const age = now.getTime() - credential.changedAt.getTime();
  return age > policy.passwordMaxAgeDays * DAY_MS;
}

/**
 * Whether `password` is one this user has already used, within the tenant's
 * configured depth.
 *
 * Verifies against stored Argon2id hashes, so this is as expensive as a
 * sign-in per remembered password. That is the reason the depth is capped in
 * the schema rather than left open: a depth of a hundred would turn every
 * password change into a hundred Argon2 verifications.
 */
export async function passwordWasUsedBefore(
  tx: TenantClient,
  userId: string,
  password: string,
  policy: AgeingPolicy,
): Promise<boolean> {
  if (policy.passwordHistoryDepth <= 0) return false;

  const previous = await tx.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: policy.passwordHistoryDepth,
    select: { hash: true },
  });

  for (const row of previous) {
    if (await verifyPassword(row.hash, password)) return true;
  }
  return false;
}

/**
 * The write side lives in `setPasswordHash`, not here.
 *
 * That function is the only way to set a password, and filing the outgoing
 * hash from inside it is what makes the history complete by construction. A
 * `recordRetiredPassword` exported alongside these two checks would be a thing
 * a future third caller could forget to call, and a reuse check with a gap in
 * its history is not a reuse check. It also keeps this module free to import
 * `verifyPassword`, which the other direction would make a cycle.
 */
