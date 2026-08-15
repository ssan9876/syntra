import { createHash, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
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
}

export async function createSession(
  tx: TenantClient,
  userId: string,
  scope: SessionScope,
  satisfiedFactor: string | null = null,
): Promise<{ token: string; expiresAt: Date }> {
  const tenantId = await currentTenant(tx);
  const token = randomBytes(32).toString('base64url');
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

/**
 * Returns the session only if it is live: not revoked, within its absolute
 * lifetime, and not idle past its scope's timeout. Any failure returns null
 * rather than distinguishing why, since the caller's response is the same.
 */
export async function resolveSession(
  tx: TenantClient,
  token: string,
): Promise<ResolvedSession | null> {
  const row = await tx.session.findFirst({
    where: { tokenHash: hashToken(token) },
  });
  if (!row || row.revokedAt) return null;

  const now = Date.now();
  if (row.absoluteExpiresAt.getTime() <= now) return null;

  const scope = row.scope as SessionScope;
  if (now - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS[scope]) return null;

  await tx.session.update({
    where: { id: row.id },
    data: { lastSeenAt: new Date() },
  });

  return {
    sessionId: row.id,
    userId: row.userId,
    scope,
    satisfiedFactor: row.satisfiedFactor,
  };
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
  if (!row || row.revokedAt) return null;

  const now = Date.now();
  if (row.absoluteExpiresAt.getTime() <= now) return null;

  const scope = row.scope as SessionScope;
  if (now - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS[scope]) return null;

  return {
    sessionId: row.id,
    userId: row.userId,
    scope,
    satisfiedFactor: row.satisfiedFactor,
  };
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

/** Used after a password change: every existing session stops working. */
export async function revokeAllForUser(
  tx: TenantClient,
  userId: string,
): Promise<void> {
  await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
