import type { FastifyInstance } from 'fastify';
import {
  createOrgUnitRequest,
  deactivateOrgUnitRequest,
  idParam,
  patchOrgUnitRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  createOrgUnit,
  deactivateOrgUnit,
  listOrgUnits,
  reactivateOrgUnit,
  recordEvent,
  wouldCycle,
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

  /**
   * Deactivate, never delete — the same rule the groups and people routes run
   * on, and the last part of the directory that had no way to obey it.
   *
   * Deleting a unit takes the record of who was in it, silently drops every
   * application assignment made on it, and orphans any administrative role
   * scoped to it. Deactivating leaves all three standing and grants nothing.
   */
  app.post(
    '/org-units/:id/deactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = deactivateOrgUnitRequest.parse(request.body);
      return request.db(async (tx) => {
        const existing = await tx.orgUnit.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'Org unit not found');
        const updated = await deactivateOrgUnit(tx, id, reason);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'orgUnit.deactivate',
          targetType: 'OrgUnit',
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
    '/org-units/:id/reactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const existing = await tx.orgUnit.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'Org unit not found');
        const updated = await reactivateOrgUnit(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'orgUnit.reactivate',
          targetType: 'OrgUnit',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: existing.name },
        });
        return updated;
      });
    },
  );

  /**
   * Renaming a unit, or moving it in the tree.
   *
   * The move is the part with teeth. `parentId` is a self-relation with no
   * acyclicity check in the database, so this endpoint is the only thing
   * standing between an administrator and a unit that is its own ancestor —
   * which does not crash anything, it just drops the units in the loop out of
   * the tree and stops their assignments reaching anybody, silently.
   */
  app.patch(
    '/org-units/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = patchOrgUnitRequest.parse(request.body);

      return request.db(async (tx) => {
        const existing = await tx.orgUnit.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'Org unit not found');
        if (existing.sourceId) {
          throw new ProblemError(
            409,
            'source-owned',
            'Managed by a directory source',
            'This unit is read from a directory source, and the next sync run would overwrite the change. Edit it where it comes from.',
          );
        }

        if (body.parentId !== undefined && body.parentId !== null) {
          const parent = await tx.orgUnit.findUnique({ where: { id: body.parentId } });
          if (!parent) {
            throw new ProblemError(404, 'not-found', 'Parent unit not found');
          }
          if (await wouldCycle(tx, id, body.parentId)) {
            throw new ProblemError(400, 'validation-failed', 'Validation failed', undefined, {
              errors: [
                {
                  path: 'parentId',
                  message:
                    'That would put the unit inside itself. Choose a parent that is not below it.',
                },
              ],
            });
          }
        }

        const updated = await tx.orgUnit.update({
          where: { id },
          data: {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
          },
        });
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'orgUnit.update',
          targetType: 'OrgUnit',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            from: { name: existing.name, parentId: existing.parentId },
            to: { name: updated.name, parentId: updated.parentId },
          },
        });
        return updated;
      });
    },
  );
}
