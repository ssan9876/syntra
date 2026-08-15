import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createUserRequest,
  deactivateUserRequest,
  idParam,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  createUser,
  deactivateUser,
  listUsers,
  recordEvent,
  type UserStatus,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const listQuery = z.object({
  status: z.enum(['active', 'inactive']).optional(),
});

export async function registerAdminUserRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/users',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { status } = listQuery.parse(request.query);
      const users = await request.db((tx) =>
        listUsers(tx, status ? { status: status as UserStatus } : {}),
      );
      return { users };
    },
  );

  app.post(
    '/users',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const body = createUserRequest.parse(request.body);

      // One transaction: if the audit write fails, the user is not created
      // either. A change without its audit entry is worse than no change.
      const user = await request.db(async (tx) => {
        let created;
        try {
          created = await createUser(tx, body);
        } catch (error) {
          if (error instanceof Error && /login already exists/i.test(error.message)) {
            throw new ProblemError(409, 'conflict', 'Conflict', error.message);
          }
          throw error;
        }

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.create',
          targetType: 'User',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { login: created.login, email: created.email },
        });
        return created;
      });

      return reply.status(201).send(user);
    },
  );

  app.post(
    '/users/:id/deactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = deactivateUserRequest.parse(request.body);

      return request.db(async (tx) => {
        const existing = await tx.user.findUnique({ where: { id } });
        if (!existing) {
          throw new ProblemError(404, 'not-found', 'User not found');
        }

        const updated = await deactivateUser(tx, id, reason);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.deactivate',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { login: existing.login, reason },
        });
        return updated;
      });
    },
  );
}
