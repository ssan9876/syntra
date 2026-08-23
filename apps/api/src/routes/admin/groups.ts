import type { FastifyInstance } from 'fastify';
import {
  createGroupRequest,
  deactivateGroupRequest,
  idParam,
  membershipParams,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  addMember,
  createGroup,
  deactivateGroup,
  listGroups,
  listMembers,
  reactivateGroup,
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

  /**
   * Deactivate, never delete — the rule this whole product runs on.
   *
   * A group is what entitlements are granted to, so deleting one silently
   * revokes access from everybody in it and takes the record of who had what
   * with it. Deactivating leaves the memberships standing, grants nothing, and
   * can be undone. Directory Sync already does exactly this when a group
   * vanishes from its source.
   */
  app.post(
    '/groups/:id/deactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = deactivateGroupRequest.parse(request.body);
      return request.db(async (tx) => {
        const existing = await tx.group.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'Group not found');
        const updated = await deactivateGroup(tx, id, reason);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'group.deactivate',
          targetType: 'Group',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: existing.name, reason },
        });
        return updated;
      });
    },
  );

  app.post(
    '/groups/:id/reactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const existing = await tx.group.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'Group not found');
        const updated = await reactivateGroup(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'group.reactivate',
          targetType: 'Group',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: existing.name },
        });
        return updated;
      });
    },
  );

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
