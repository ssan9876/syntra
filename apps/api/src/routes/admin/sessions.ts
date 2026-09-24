import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParam, revokeTenantSessionsRequest } from '@syntra/contracts';
import {
  PERMISSIONS,
  STEP_UP_MAX_AGE_MS,
  endSessions,
  isRecentElevation,
  listSessionsForUser,
  revokeTenantSessions,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

export const sessionParams = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
});

/**
 * Somebody else's sessions, listed and ended.
 *
 * This exists because the documentation already told administrators to use it.
 * "If you need a rule to bite immediately, revoke the sessions as well" was
 * advice with no route behind it: the only way to revoke somebody's sessions
 * was to change their password, which is a considerably larger act than the
 * one being asked for.
 *
 * Guarded by `directory.write`, and NO step-up. Revocation GRANTS NOTHING — it
 * is the same authority as deactivating the account, exercised more narrowly,
 * and demanding a second factor to take access away would make the safe act
 * harder than the dangerous one.
 */
export async function registerAdminSessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/users/:id/sessions',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const sessions = await request.db((tx) => listSessionsForUser(tx, id));
      return { sessions };
    },
  );

  app.delete(
    '/users/:id/sessions/:sessionId',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id, sessionId } = sessionParams.parse(request.params);

      await request.db(async (tx) => {
        // Scoped to the user named in the path, so a session id on its own is
        // not a capability to end any session in the tenant. The id comes from
        // a list the caller was already entitled to read; this makes it mean
        // nothing anywhere else.
        const owned = await tx.session.findFirst({
          where: { id: sessionId, userId: id, revokedAt: null },
          select: { id: true },
        });
        if (!owned) throw new ProblemError(404, 'not-found', 'Session not found');

        await endSessions(tx, id, {
          trigger: 'admin',
          actorUserId: request.session.userId,
          sourceIp: request.ip,
          onlySessionId: sessionId,
        });
      });

      return reply.code(204).send();
    },
  );

  app.post(
    '/users/:id/sessions/revoke',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      return request.db(async (tx) => {
        const { sessionsRevoked } = await endSessions(tx, id, {
          trigger: 'admin',
          actorUserId: request.session.userId,
          sourceIp: request.ip,
        });
        return { sessionsRevoked };
      });
    },
  );

  /**
   * Every session in the tenant, or every administrative one, at once.
   *
   * Unlike the per-user routes above, this one DOES demand step-up, and the
   * argument that exempts them does not carry over. Ending one person's
   * sessions grants nothing and harms nobody but the person; ending everyone's
   * is an outage for the whole organization, and a stolen console session
   * that could press it would be a denial of service on demand. So: the
   * tenant-level permission rather than `directory.write`, no bearer tokens
   * (see `TOKEN_DENIED_ROUTES`), and an administrative session established in
   * the last `STEP_UP_MAX_AGE_MS` — a fresh elevation, which re-ran the
   * password and every factor the tenant demands.
   *
   * Everything below the checks is `revokeTenantSessions`, which sends every
   * affected user through `endSessions`: refresh tokens and back-channel
   * logout go with the sessions, exactly as they do for one user.
   */
  app.post(
    '/sessions/revoke',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const body = revokeTenantSessionsRequest.parse(request.body);

      // Belt to `TOKEN_DENIED_ROUTES`' braces: a principal that got here by a
      // token has no elevation to be recent.
      if (request.session.viaToken || !isRecentElevation(request.session)) {
        throw new ProblemError(
          403,
          'step-up-required',
          'Confirm it is you first',
          `Revoking sessions across the organization needs a console session started in the last ${STEP_UP_MAX_AGE_MS / 60_000} minutes. Elevate again, then retry.`,
        );
      }

      return revokeTenantSessions(request.tenantId, {
        scope: body.scope,
        actorUserId: request.session.userId,
        exceptSessionId: body.keepCurrentSession
          ? request.session.sessionId
          : undefined,
        sourceIp: request.ip,
        reason: body.reason,
      });
    },
  );
}
