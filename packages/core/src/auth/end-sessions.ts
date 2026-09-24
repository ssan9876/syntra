import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { enqueueLogoutDeliveries } from '../access/logout-delivery.js';
import { revokeAllRefreshTokensForUser } from './refresh-token.js';
import {
  revokeAllForUser,
  revokeAllForUserExcept,
  revokeScopeForUser,
  revokeSessionById,
  type SessionScope,
} from './session-service.js';

/**
 * What ended the sessions. Recorded on the audit event, so the set of
 * revocations is readable by cause rather than only by count.
 */
export type RevocationTrigger =
  | 'admin'
  | 'self'
  | 'logout'
  | 'password_reset'
  | 'password_change'
  | 'deactivation'
  /** An administrator ended sessions across the whole tenant at once. */
  | 'mass_revoke';

export interface EndSessionsOptions {
  trigger: RevocationTrigger;
  /** Who did it. Null for a run with nobody behind it, like a sync. */
  actorUserId?: string | null;
  sourceIp?: string | null;
  /** Spared, for a self-service change made from the session in hand. */
  exceptSessionId?: string;
  /** Ends exactly one session rather than all of them. */
  onlySessionId?: string;
  /**
   * Ends only the sessions of this scope. Combines with `exceptSessionId`.
   *
   * Refresh tokens are still revoked wholesale, as they are for a single
   * session: a refresh token is not bound to the session that minted it, so
   * sparing some would leave a way to refresh past the revocation.
   */
  onlyScope?: SessionScope;
}

/**
 * THE one way a user's access is taken away.
 *
 * It revokes the sessions, revokes the refresh tokens, and tells every relying
 * party that asked to be told — in one transaction, the caller's.
 *
 * This exists because doing those three things is not optional and was
 * previously three separate decisions. `refresh-token.ts` carries the
 * docstring of what that cost the first time:
 *
 *   > the version of this function that revoked only the empty one satisfied
 *   > the letter of every caller and none of the point: a phished password
 *   > already exchanged for a refresh token survived the reset for fourteen
 *   > days
 *
 * A second version of that bug is available for free the moment propagation is
 * something a caller has to remember. So `revokeAllForUser` and
 * `revokeAllForUserExcept` are no longer exported from this package, and this
 * is what replaced them: a caller that wants to end sessions cannot express
 * ending them quietly, because there is no longer a function that does.
 *
 * All four steps inside the caller's transaction. A reset that changed the
 * password and then failed to revoke is worse than either half on its own, and
 * a revocation that failed to enqueue is the same shape of defect.
 */
export async function endSessions(
  tx: TenantClient,
  userId: string,
  options: EndSessionsOptions,
): Promise<{ sessionsRevoked: number; logoutsEnqueued: number }> {
  const tenantId = await currentTenant(tx);

  const sessionsRevoked = options.onlySessionId
    ? (await revokeSessionById(tx, options.onlySessionId))
      ? 1
      : 0
    : options.onlyScope
      ? await revokeScopeForUser(
          tx,
          userId,
          options.onlyScope,
          options.exceptSessionId,
        )
      : options.exceptSessionId
        ? await revokeAllForUserExcept(tx, userId, options.exceptSessionId)
        : await revokeAllForUser(tx, userId);

  // ENQUEUE FIRST, THEN REVOKE. This order is load-bearing and not obvious.
  //
  // `enqueueLogoutDeliveries` works out who to tell by reading the OIDC
  // artifacts — a relying party is told because the person holds a live grant
  // with it. `revokeAllRefreshTokensForUser` DELETES those artifacts. Revoking
  // first leaves nothing to read, so every logout is enqueued for nobody and
  // the whole feature is silently inert: sessions end, tokens die, and not one
  // relying party is told. The tests below caught exactly that.
  const logoutsEnqueued = await enqueueLogoutDeliveries(tx, tenantId, {
    userId,
    sessionId: options.onlySessionId ?? null,
  });

  // Both stores, always. `revokeAllRefreshTokensForUser` covers Syntra's own
  // table and the OIDC artifacts a relying party's tokens actually live in.
  //
  // Done even for a single-session revoke. A refresh token outlives the
  // session that minted it and is not scoped to it, so ending one session and
  // leaving the refresh token alive would be a revocation somebody could
  // simply refresh their way past.
  await revokeAllRefreshTokensForUser(tx, userId);

  await recordEvent(tx, {
    actorUserId: options.actorUserId ?? null,
    action: 'session.revoked',
    targetType: 'User',
    targetId: userId,
    outcome: 'success',
    sourceIp: options.sourceIp ?? null,
    payload: {
      trigger: options.trigger,
      count: sessionsRevoked,
      logoutsEnqueued,
      ...(options.onlySessionId ? { sessionId: options.onlySessionId } : {}),
      ...(options.onlyScope ? { scope: options.onlyScope } : {}),
    },
  });

  return { sessionsRevoked, logoutsEnqueued };
}

export interface TenantRevocationOptions {
  /** `admin` ends only administrative sessions; `all` ends every session. */
  scope: 'all' | 'admin';
  actorUserId: string;
  /**
   * The session making the request, spared when set. Only ever the actor's
   * own — it is applied to the actor's user and to nobody else's.
   */
  exceptSessionId?: string | undefined;
  sourceIp: string | null;
  /** Why. Required, and recorded on the summary event. */
  reason: string;
}

export interface TenantRevocationResult {
  usersAffected: number;
  sessionsRevoked: number;
  logoutsEnqueued: number;
}

/**
 * Users revoked per transaction.
 *
 * Small enough that a batch of the heaviest users — each with OIDC artifacts
 * to read and delete — finishes well inside Prisma's five-second interactive
 * transaction limit; large enough that a tenant of ten thousand is four
 * hundred round trips rather than ten thousand.
 */
const REVOCATION_BATCH = 25;

/**
 * Ends sessions across the whole tenant — the incident-response button.
 *
 * EVERY USER GOES THROUGH `endSessions`. That is the whole design, and the
 * reason this is here rather than an `updateMany` over the session table: a
 * tenant-wide revoke that ended the rows and left the refresh tokens alive,
 * or told no relying party, would be the defect `endSessions` exists to make
 * unwritable, committed at the scale where it matters most. So each affected
 * user gets exactly what a single-user revoke gives them — sessions revoked,
 * refresh tokens and OIDC artifacts revoked, back-channel logouts enqueued,
 * and a `session.revoked` event with trigger `mass_revoke`.
 *
 * Who is affected, for `all`: anybody holding an unrevoked session, an
 * unrevoked refresh token, or an OIDC artifact. The last two matter because
 * a refresh token outlives the session that minted it; "revoke every session"
 * that left somebody able to mint a new access token would not be what the
 * administrator pressing the button believed they did. For `admin`: anybody
 * holding an unrevoked administrative session — the answer to "an
 * administrator's credentials may have leaked" that does not sign the whole
 * organization out of the portal as well.
 *
 * Batched, one transaction per batch, and NOT one transaction for the lot.
 * A tenant of any size would overrun the transaction limit, and a revocation
 * that rolled back entirely because user 9,000 timed out would have ended
 * nobody. Each batch is atomic per user as `endSessions` promises; the run as
 * a whole is recorded by a summary event — `session.mass_revoked` on success,
 * or the same action with outcome `failure` and the counts so far if a batch
 * throws — so a partial run is visible rather than silent, and pressing the
 * button again finishes it: already-revoked sessions are not counted twice.
 */
export async function revokeTenantSessions(
  tenantId: string,
  options: TenantRevocationOptions,
): Promise<TenantRevocationResult> {
  const userIds = await withTenant(tenantId, async (tx) => {
    const ids = new Set<string>();
    const sessions = await tx.session.findMany({
      where: {
        revokedAt: null,
        ...(options.scope === 'admin' ? { scope: 'admin' } : {}),
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const s of sessions) ids.add(s.userId);

    if (options.scope === 'all') {
      const refresh = await tx.refreshToken.findMany({
        where: { revokedAt: null },
        select: { userId: true },
        distinct: ['userId'],
      });
      for (const r of refresh) ids.add(r.userId);
      const artifacts = await tx.oidcArtifact.findMany({
        where: { accountId: { not: null } },
        select: { accountId: true },
        distinct: ['accountId'],
      });
      for (const a of artifacts) if (a.accountId) ids.add(a.accountId);
    }
    // Sorted so a re-run after a partial failure walks the same order, and a
    // test can say which users a batch held.
    return [...ids].sort();
  });

  const totals: TenantRevocationResult = {
    usersAffected: 0,
    sessionsRevoked: 0,
    logoutsEnqueued: 0,
  };

  const summary = (outcome: 'success' | 'failure', error?: string) =>
    withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: options.actorUserId,
        action: 'session.mass_revoked',
        targetType: 'Tenant',
        targetId: tenantId,
        outcome,
        sourceIp: options.sourceIp,
        payload: {
          scope: options.scope,
          reason: options.reason,
          keptCurrentSession: Boolean(options.exceptSessionId),
          usersFound: userIds.length,
          ...totals,
          ...(error ? { error } : {}),
        },
      }),
    );

  try {
    for (let i = 0; i < userIds.length; i += REVOCATION_BATCH) {
      const batch = userIds.slice(i, i + REVOCATION_BATCH);
      const done = await withTenant(tenantId, async (tx) => {
        const local = { users: 0, sessions: 0, logouts: 0 };
        for (const userId of batch) {
          const spare =
            userId === options.actorUserId ? options.exceptSessionId : undefined;
          const result = await endSessions(tx, userId, {
            trigger: 'mass_revoke',
            actorUserId: options.actorUserId,
            sourceIp: options.sourceIp,
            ...(spare ? { exceptSessionId: spare } : {}),
            ...(options.scope === 'admin' ? { onlyScope: 'admin' as const } : {}),
          });
          local.users += 1;
          local.sessions += result.sessionsRevoked;
          local.logouts += result.logoutsEnqueued;
        }
        return local;
      });
      // Added only once the batch has COMMITTED. A batch that throws rolls
      // back, and counting its users would have the failure event claim
      // revocations that never happened.
      totals.usersAffected += done.users;
      totals.sessionsRevoked += done.sessions;
      totals.logoutsEnqueued += done.logouts;
    }
  } catch (cause) {
    await summary(
      'failure',
      cause instanceof Error ? cause.message.slice(0, 200) : 'unknown',
    );
    throw cause;
  }

  await summary('success');
  return totals;
}
