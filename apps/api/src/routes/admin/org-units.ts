import type { FastifyInstance } from 'fastify';
import { createOrgUnitRequest } from '@syntra/contracts';
import {
  PERMISSIONS,
  createOrgUnit,
  listOrgUnits,
  recordEvent,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export async function registerAdminOrgUnitRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/org-units',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => ({
      orgUnits: await request.db((tx) => listOrgUnits(tx)),
    }),
  );

  app.post(
    '/org-units',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const body = createOrgUnitRequest.parse(request.body);

      const unit = await request.db(async (tx) => {
        if (body.parentId) {
          const parent = await tx.orgUnit.findUnique({
            where: { id: body.parentId },
          });
          if (!parent) {
            throw new ProblemError(404, 'not-found', 'Parent unit not found');
          }
        }

        const created = await createOrgUnit(tx, body.name, body.parentId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'orgUnit.create',
          targetType: 'OrgUnit',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: created.name, parentId: created.parentId },
        });
        return created;
      });

      return reply.status(201).send(unit);
    },
  );
}
