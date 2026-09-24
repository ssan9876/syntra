import { createHash, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import type { AuthorizeResult } from './authorize.js';
import { currentTenant } from '../tenant-context.js';

export type SessionScope = 'portal' | 'admin';

const MINUTE_MS = 60 * 1000;

/**
 * How long a session of each scope may live, and what else it must satisfy,
 * as the tenant has configured it.
 *
 * Administrative sessions expire sooner in both senses. This is the
 * server-side half of running one web application for two audiences: an
 * elevated session is short-lived by construction, not by convention. The
 * numbers used to be constants here; they are now the tenant's, within the
 * platform bounds `SESSION_POLICY_BOUNDS` sets and the database's CHECK
 * constraints repeat, and their defaults are the constants they replaced —
 * portal 60 minutes idle / 12 hours absolute, admin 15 minutes / 2 hours.
 */
export interface SessionPolicy {
  idleMs: Record<SessionScope, number>;
  absoluteMs: Record<SessionScope, number>;
  /**
   * An administrative session is only live if WebAuthn established it.
   *
   * Read on every request, not only at elevation. Turning the requirement on
   * after an incident is precisely when an administrator needs the sessions
   * that were minted with an authenticator-app code to stop working, and
   * "the next elevation will need a key" is two hours too late for that.
   */
  adminWebauthnRequired: boolean;
}

/**
 * The tenant's session policy, read from the tenant row.
 *
 * One indexed primary-key read. Every reader below pays it once per call —
 * `listSessionsForUser` once for the whole list, not per row.
 */
export async function readSessionPolicy(tx: TenantClient): Promise<SessionPolicy> {
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: {
      portalSessionIdleMinutes: true,
      portalSessionAbsoluteMinutes: true,
      adminSessionIdleMinutes: true,
      adminSessionAbsoluteMinutes: true,
      adminWebauthnRequired: true,
    },
  });
  return {
    idleMs: {
      portal: tenant.portalSessionIdleMinutes * MINUTE_MS,
      admin: tenant.adminSessionIdleMinutes * MINUTE_MS,
    },
    absoluteMs: {
      portal: tenant.portalSessionAbsoluteMinutes * MINUTE_MS,
      admin: tenant.adminSessionAbsoluteMinutes * MINUTE_MS,
    },
    adminWebauthnRequired: tenant.adminWebauthnRequired,
  };
}

/**
 * How recently an administrative session must have been established for an
 * action that demands step-up.
 *
 * Step-up here is recency of a full elevation, the model sometimes called
 * "sudo mode": elevation re-enters `authorize()` with the password and every
 * factor the tenant's floor, policy and phishing-resistance setting demand,
 * so a session minted in the last ten minutes IS a fresh strong
 * authentication. Re-verifying a factor inline would need a second, parallel
 * route to an allow — the thing this codebase has spent a long time removing
 * — and would still not re-check the password.
 *
 * Ten minutes: long enough to elevate, read what you are about to do and do
 * it; short enough that a console left open after lunch cannot sign the whole
 * tenant out.
 */
export const STEP_UP_MAX_AGE_MS = 10 * MINUTE_MS;

/** Whether this session counts as a fresh step-up. */
export function isRecentElevation(
  session: { scope: SessionScope; createdAt: Date },
  now: number = Date.now(),
): boolean {
  return (
    session.scope === 'admin' &&
    now - session.createdAt.getTime() <= STEP_UP_MAX_AGE_MS
  );
}

/**
 * The moment a session stops being good on age alone, under the CURRENT
 * policy.
 *
 * The earlier of two instants: the expiry stamped on the row at issue, and
 * issue time plus today's absolute lifetime. The first means lengthening the
 * policy never extends a session already issued — its cookie was written with
 * the old expiry and will not come back after it anyway, and a session that
 * quietly outlived the lifetime it was granted under would be a surprise to
 * whoever granted it. The second means SHORTENING takes effect at once: a
 * tenant that drops admin sessions from two hours to thirty minutes has not
 * got ninety minutes of old, longer sessions still running.
 */
function effectiveExpiry(
  row: { scope: string; createdAt: Date; absoluteExpiresAt: Date },
  policy: SessionPolicy,
): Date {
  const scope = row.scope as SessionScope;
  const byPolicy = row.createdAt.getTime() + policy.absoluteMs[scope];
  return new Date(Math.min(row.absoluteExpiresAt.getTime(), byPolicy));
}

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
 * Where a session was established from. Description, not authority.
 *
 * A separate parameter from `SessionAllowance` on purpose. Everything the
 * decision carries is read off the decision, "never taken from ambient request
 * state" — and an address and a user agent ARE ambient request state. Folding
 * them into the allowance would make that sentence false, and that sentence is
 * the thing that stops a route passing a user id its decision does not carry.
 *
 * Two parameters with two meanings: the decision says who may have a session,
 * the origin says what the browser looked like when they got one. Nothing ever
 * reads the origin back to make a decision — a session is not refused for
 * having moved — so it is safe for it to be attacker-influenced, and it has to
 * be, because it is.
 *
 * Required rather than optional. A caller with nothing to say passes nulls,
 * which is one keystroke; a caller that FORGOT would otherwise get nulls
 * silently, and the whole point of the inventory is that the columns are
 * populated.
 */
export interface SessionOrigin {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Attacker-controlled text of unbounded length, kept only to be read by a
 * human. Truncated rather than validated: there is no grammar to check it
 * against, and a header nobody parses cannot be malformed.
 */
const USER_AGENT_MAX = 256;

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
  origin: SessionOrigin,
): Promise<{ token: string; expiresAt: Date }> {
  const tenantId = await currentTenant(tx);
  const token = randomBytes(32).toString('base64url');
  const { userId, scope, satisfiedFactor } = decision;
  const policy = await readSessionPolicy(tx);
  const absoluteExpiresAt = new Date(Date.now() + policy.absoluteMs[scope]);

  await tx.session.create({
    data: {
      tenantId,
      userId,
      tokenHash: hashToken(token),
      scope,
      satisfiedFactor,
      absoluteExpiresAt,
      ip: origin.ip,
      userAgent: origin.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
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
 *
 * The lifetimes and the phishing-resistance requirement are the tenant's
 * CURRENT policy, passed in, not whatever applied when the row was written —
 * see `effectiveExpiry` for why that is the direction that matters.
 */
async function isLive(
  tx: TenantClient,
  row: SessionRow,
  now: number,
  policy: SessionPolicy,
): Promise<boolean> {
  if (row.revokedAt) return false;
  if (effectiveExpiry(row, policy).getTime() <= now) return false;

  const scope = row.scope as SessionScope;
  if (now - row.lastSeenAt.getTime() > policy.idleMs[scope]) return false;

  // An administrative session that a code, not a key, established. Only the
  // admin scope: the requirement is about the console, and a portal session
  // authorises nothing the policy is protecting. `authorize()` refuses to
  // MINT such a session while the policy is on; this ends the ones minted
  // before it was switched on.
  if (
    scope === 'admin' &&
    policy.adminWebauthnRequired &&
    row.satisfiedFactor !== 'webauthn'
  ) {
    return false;
  }

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
  if (!(await isLive(tx, row, now, await readSessionPolicy(tx)))) return null;

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
  if (!(await isLive(tx, row, Date.now(), await readSessionPolicy(tx)))) {
    return null;
  }
  return toResolved(row);
}

/**
 * A session as somebody is shown it.
 *
 * Never the token hash. There is no screen on which a session's stored digest
 * is a thing anybody needs, and a list is read by the person whose sessions
 * they are — the one reader for whom leaking it would matter least and still
 * matter.
 */
export interface SessionSummary {
  id: string;
  scope: SessionScope;
  satisfiedFactor: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Every session of this user's that is still good, newest first.
 *
 * "Still good" is `isLive`'s answer and nobody else's — the same predicate
 * `resolveSession` and `readSession` use, which covers revocation, the
 * absolute lifetime, the per-scope idle timeout AND the account still being
 * active. Filtering on `revokedAt: null` alone would list sessions that
 * stopped working hours ago, and the first thing anybody would do is revoke
 * one of them and wonder why nothing changed.
 *
 * The cost is one query per row, as every other reader here pays. A list is
 * drawn by a person looking at one account, not on the request path.
 */
export async function listSessionsForUser(
  tx: TenantClient,
  userId: string,
): Promise<SessionSummary[]> {
  const now = Date.now();
  const policy = await readSessionPolicy(tx);
  const rows = await tx.session.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const live: SessionSummary[] = [];
  for (const row of rows) {
    if (!(await isLive(tx, row, now, policy))) continue;
    live.push({
      id: row.id,
      scope: row.scope as SessionScope,
      satisfiedFactor: row.satisfiedFactor,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      // The expiry that will actually apply, not the one stamped at issue. A
      // list that said "expires in 9 hours" about a session the shortened
      // policy will end in one would be the inventory lying about the thing
      // it exists to show.
      absoluteExpiresAt: effectiveExpiry(row, policy),
    });
  }
  return live;
}

/**
 * Revokes one session by its id rather than by its token.
 *
 * The token is what a holder presents; the id is what a list offers. An
 * administrator ending somebody else's session has the second and must never
 * need the first — a route that took a token would be a route that had to be
 * given one.
 *
 * Returns whether anything changed, so a caller can answer 404 for a session
 * that is not there instead of a cheerful 200 for a no-op. Already-revoked
 * counts as no change: saying "revoked" twice about one act would let a
 * caller believe it had ended two sessions.
 */
export async function revokeSessionById(
  tx: TenantClient,
  sessionId: string,
): Promise<boolean> {
  const { count } = await tx.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
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
/**
 * NOT EXPORTED FROM THE PACKAGE. `endSessions` is the only caller, and that is
 * the mechanism rather than a convention: revoking sessions without revoking
 * refresh tokens and without telling the relying parties is a defect this
 * project has already shipped once, and the fix is that it can no longer be
 * written. See `end-sessions.ts`.
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
/** Not exported from the package either. See `revokeAllForUser` above. */
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

/**
 * Every session of ONE scope for this user, optionally sparing one. Used by
 * the tenant-wide revoke when it is narrowed to administrative sessions.
 *
 * A sibling rather than a flag on the two above. Their docstrings are about
 * a caller ending the wrong set, and a function whose name says which set it
 * ends is harder to misuse than one whose options do.
 *
 * Not exported from the package either. See `revokeAllForUser` above.
 */
export async function revokeScopeForUser(
  tx: TenantClient,
  userId: string,
  scope: SessionScope,
  exceptSessionId?: string,
): Promise<number> {
  const { count } = await tx.session.updateMany({
    where: {
      userId,
      scope,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return count;
}
