import type { FastifyInstance } from 'fastify';
import {
  createGroupRequest,
  idParam,
  membershipParams,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  addMember,
  createGroup,
  listGroups,
  listMembers,
  recordEvent,
  removeMember,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export async function registerAdminGroupRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/groups',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => ({ groups: await request.db((tx) => listGroups(tx)) }),
  );

  app.post(
    '/groups',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const body = createGroupRequest.parse(request.body);

      const group = await request.db(async (tx) => {
        const existing = await tx.group.findFirst({ where: { name: body.name } });
        if (existing) {
          throw new ProblemError(
            409,
            'conflict',
            'Conflict',
            `group already exists: ${body.name}`,
          );
        }

        const created = await createGroup(tx, body.name, body.description);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'group.create',
          targetType: 'Group',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: created.name },
        });
        return created;
      });

      return reply.status(201).send(group);
    },
  );

  app.get(
    '/groups/:id/members',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return { users: await request.db((tx) => listMembers(tx, id)) };
    },
  );

  app.post(
    '/groups/:id/members/:userId',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id, userId } = membershipParams.parse(request.params);

      await request.db(async (tx) => {
        const group = await tx.group.findUnique({ where: { id } });
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!group || !user) {
          throw new ProblemError(404, 'not-found', 'Group or user not found');
        }

        await addMember(tx, id, userId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'group.addMember',
          targetType: 'Group',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { group: group.name, login: user.login },
        });
      });

      return reply.status(204).send();
    },
  );

  app.delete(
    '/groups/:id/members/:userId',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id, userId } = membershipParams.parse(request.params);

      await request.db(async (tx) => {
        await removeMember(tx, id, userId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'group.removeMember',
          targetType: 'Group',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { userId },
        });
      });

      return reply.status(204).send();
    },
  );
}
