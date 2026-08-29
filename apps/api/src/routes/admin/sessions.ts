import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParam } from '@syntra/contracts';
import {
  PERMISSIONS,
  listSessionsForUser,
  recordEvent,
  revokeAllForUser,
  revokeSessionById,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

const sessionParams = z.object({
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

        await revokeSessionById(tx, sessionId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'session.revoked',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { trigger: 'admin', count: 1, sessionId },
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
        const count = await revokeAllForUser(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'session.revoked',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { trigger: 'admin', count },
        });
        return { sessionsRevoked: count };
      });
    },
  );
}
