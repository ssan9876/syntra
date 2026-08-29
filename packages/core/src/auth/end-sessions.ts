import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { enqueueLogoutDeliveries } from '../access/logout-delivery.js';
import { revokeAllRefreshTokensForUser } from './refresh-token.js';
import {
  revokeAllForUser,
  revokeAllForUserExcept,
  revokeSessionById,
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
  | 'deactivation';

export interface EndSessionsOptions {
  trigger: RevocationTrigger;
  /** Who did it. Null for a run with nobody behind it, like a sync. */
  actorUserId?: string | null;
  sourceIp?: string | null;
  /** Spared, for a self-service change made from the session in hand. */
  exceptSessionId?: string;
  /** Ends exactly one session rather than all of them. */
  onlySessionId?: string;
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
    },
  });

  return { sessionsRevoked, logoutsEnqueued };
}
