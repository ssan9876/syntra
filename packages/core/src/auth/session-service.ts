import { createHash, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import type { AuthorizeResult } from './authorize.js';
import { currentTenant } from '../tenant-context.js';

export type SessionScope = 'portal' | 'admin';

/**
 * Administrative sessions expire sooner in both senses. This is the
 * server-side half of running one web application for two audiences: an
 * elevated session is short-lived by construction, not by convention.
 */
const ABSOLUTE_LIFETIME_MS: Record<SessionScope, number> = {
  portal: 12 * 60 * 60 * 1000,
  admin: 2 * 60 * 60 * 1000,
};

const IDLE_TIMEOUT_MS: Record<SessionScope, number> = {
  portal: 60 * 60 * 1000,
  admin: 15 * 60 * 1000,
};

/**
 * Only the digest is stored. A leaked database gives an attacker hashes, not
 * usable session tokens.
 */
const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  scope: SessionScope;
  /**
   * The second factor this session was established with, if any.
   *
   * Read by anything that re-enters authorize() holding a session. Launching
   * an application is a fresh decision, but it is not a fresh sign-in, and the
   * factor the user already presented still counts. Without this, every launch
   * of an application covered by a require_mfa rule issues the same challenge
   * the user has just answered, and the application is unreachable forever.
   */
  satisfiedFactor: string | null;
  /**
   * When this session was minted.
   *
   * Read by the SAML identity provider to answer `ForceAuthn`: a service
   * provider demanding a fresh authentication is answered by a session NEWER
   * than the request, and by nothing else. Comparing against the request's own
   * `createdAt` is what makes "sign in again" a thing the user can actually
   * do -- before it, the flag was checked, never satisfied, and the browser
   * bounced between the login screen and `/saml/continue` until the parked row
   * expired.
   */
  createdAt: Date;
}

/**
 * An allow from the chokepoint. The only thing a session can be minted from.
 *
 * A type alias rather than four loose parameters, and that is the whole point.
 * `createSession(tx, userId, 'admin', 'webauthn')` was one call away from an
 * administrative session with no authentication behind it at all — strictly
 * more powerful than the `issueAttempt` and `authorize({ kind: 'continue' })`
 * pair that was withdrawn from the package's exports for exactly that reason,
 * because it needs no attempt and no factor either. The routes genuinely need
 * this function, so it stays exported; what changes is that the caller must be
 * holding a decision, and a caller who has not been past `authorize()` cannot
 * produce one. The wrong thing does not compile.
 *
 * `import type` on the way in, so the runtime import graph stays acyclic:
 * authorize.ts imports this module for real, and this one takes only its
 * shape.
 */
export type SessionAllowance = Extract<AuthorizeResult, { status: 'allow' }>;

/**
 * Mints a session for a decision that has already been made.
 *
 * Everything the session records — who it belongs to, its scope, the factor
 * that established it — is read off the decision, never taken from ambient
 * request state. A route that thought it knew the user id is how an elevation
 * came to pass one value while its decision carried another.
 */
export async function createSession(
  tx: TenantClient,
  decision: SessionAllowance,
): Promise<{ token: string; expiresAt: Date }> {
  const tenantId = await currentTenant(tx);
  const token = randomBytes(32).toString('base64url');
  const { userId, scope, satisfiedFactor } = decision;
  const absoluteExpiresAt = new Date(Date.now() + ABSOLUTE_LIFETIME_MS[scope]);

  await tx.session.create({
    data: {
      tenantId,
      userId,
      tokenHash: hashToken(token),
      scope,
      satisfiedFactor,
      absoluteExpiresAt,
    },
  });

  return { token, expiresAt: absoluteExpiresAt };
}

/** The shape both readers work from. */
interface SessionRow {
  id: string;
  userId: string;
  scope: string;
  satisfiedFactor: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Whether a session row still authorises anything, asked in one place.
 *
 * Four conditions, and the fourth is the one that is easy to forget: the
 * account behind the session must still be active. Deactivation revokes every
 * session it can see (see `deactivateUser`), but a session that predates that
 * fix — or one created by a path that forgets — would otherwise keep working
 * until it expired, and for an administrator that is two hours of privileged
 * writes after they were offboarded. Revocation closes the window going
 * forward; this closes it for everything already issued.
 *
 * The user is read rather than joined because Session carries no relation to
 * User. One extra indexed lookup per authenticated request is the price of
 * offboarding taking effect at the next request instead of at the next
 * expiry.
 */
async function isLive(
  tx: TenantClient,
  row: SessionRow,
  now: number,
): Promise<boolean> {
  if (row.revokedAt) return false;
  if (row.absoluteExpiresAt.getTime() <= now) return false;

  const scope = row.scope as SessionScope;
  if (now - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS[scope]) return false;

  const user = await tx.user.findUnique({ where: { id: row.userId } });
  if (!user || user.status !== 'active') return false;

  return true;
}

const toResolved = (row: SessionRow): ResolvedSession => ({
  sessionId: row.id,
  userId: row.userId,
  scope: row.scope as SessionScope,
  satisfiedFactor: row.satisfiedFactor,
  createdAt: row.createdAt,
});

/**
 * Returns the session only if it is live: not revoked, within its absolute
 * lifetime, not idle past its scope's timeout, and belonging to an account
 * that is still active. Any failure returns null rather than distinguishing
 * why, since the caller's response is the same.
 */
export async function resolveSession(
  tx: TenantClient,
  token: string,
): Promise<ResolvedSession | null> {
  const row = await tx.session.findFirst({
    where: { tokenHash: hashToken(token) },
  });
  if (!row) return null;

  const now = Date.now();
  if (!(await isLive(tx, row, now))) return null;

  await tx.session.update({
    where: { id: row.id },
    data: { lastSeenAt: new Date() },
  });

  return toResolved(row);
}

/**
 * Reads a live session by its id, without touching it.
 *
 * For a caller that already holds a session and is re-entering authorize() —
 * launching an application. The liveness rules are resolveSession's, because
 * two answers to "is this session still good" is one answer too many. It does
 * not update `lastSeenAt`: the request that carried the cookie has already
 * done that, and a second write here would extend the idle window for free
 * every time a decision is re-evaluated.
 */
export async function readSession(
  tx: TenantClient,
  sessionId: string,
): Promise<ResolvedSession | null> {
  const row = await tx.session.findUnique({ where: { id: sessionId } });
  if (!row) return null;
  if (!(await isLive(tx, row, Date.now()))) return null;
  return toResolved(row);
}

export async function revokeSession(
  tx: TenantClient,
  token: string,
): Promise<void> {
  await tx.session.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { revokedAt: new Date() },
  });
}

/**
 * Used after a password reset or a deactivation: every existing session stops
 * working.
 */
export async function revokeAllForUser(
  tx: TenantClient,
  userId: string,
): Promise<number> {
  // Returns the count, as `revokeAllForUserExcept` below does. The two do the
  // same job to a different set and had no reason to disagree about what they
  // report; a caller that wants to say "three sessions were revoked" should
  // not have to count them itself and race the update while doing it. Existing
  // callers ignore it.
  const { count } = await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

/**
 * Every session except the one asking. Used by a self-service password change.
 *
 * A CHANGE IS NOT A RESET. A reset is somebody proving control of a mailbox
 * from an unknown place, so nothing that existed beforehand is trusted and
 * `revokeAllForUser` is right. A change is somebody already signed in who
 * typed their current password; the session in their hand is the one piece of
 * evidence the whole request rests on, and revoking it logs them out of the
 * tab they are looking at at the very moment they are told it worked.
 *
 * The other sessions still go. That is the point of changing a password after
 * somebody else has learned it, and leaving them alive would make the change
 * cosmetic.
 */
export async function revokeAllForUserExcept(
  tx: TenantClient,
  userId: string,
  sessionId: string,
): Promise<number> {
  const { count } = await tx.session.updateMany({
    where: { userId, revokedAt: null, id: { not: sessionId } },
    data: { revokedAt: new Date() },
  });
  return count;
}
