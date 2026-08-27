import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createOrgUnitRequest,
  deactivateOrgUnitRequest,
  idParam,
  materialiseOrgUnitRequest,
  patchOrgUnitRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  containersForOrgUnit,
  createOrgUnit,
  deactivateOrgUnit,
  deleteDirectoryOrgUnit,
  listOrgUnits,
  materialiseOrgUnit,
  unmaterialiseOrgUnit,
  localMasterKeyProvider,
  reactivateOrgUnit,
  recordEvent,
  wouldCycle,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface AdminOrgUnitRouteOptions {
  /** Unseals a directory source's bind credential for a write-back delete. */
  masterKey: Buffer;
}

const targetParam = z.object({ targetSystemId: z.string().uuid() });

export async function registerAdminOrgUnitRoutes(
  app: FastifyInstance,
  options: AdminOrgUnitRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);

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

  /**
   * Deleting a unit, refused unless it is empty.
   *
   * The note on deactivate above still stands for the ordinary case: deleting
   * a populated unit takes the record of who was in it, drops every
   * application assignment made on it and orphans any role scoped to it. That
   * is what the emptiness check is protecting, and it is why the refusal names
   * what is still inside rather than saying "not empty" — the reader's next
   * question is what to move.
   */
  app.get(
    '/org-units/:id/containers',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return { containers: await request.db((tx) => containersForOrgUnit(tx, id)) };
    },
  );

  /**
   * Materialise a unit against one target: bind it to a container DN there.
   *
   * Deliberately a SECOND step, never folded into creating the unit. "I made a
   * department in Syntra" and "put a container in my domain" are different
   * decisions, and Ruling P9 (revised) rests on the second having been made
   * explicitly -- Provision creates a container only where an administrator
   * asked for one by name.
   *
   * Writes the row and nothing to the directory. The container itself is
   * created by the next provisioning run, under the guard, in a plan somebody
   * can preview.
   */
  app.post(
    '/org-units/:id/containers',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = materialiseOrgUnitRequest.parse(request.body);

      const outcome = await materialiseOrgUnit(request.tenantId, provider, {
        orgUnitId: id,
        targetSystemId: body.targetSystemId,
        dn: body.dn,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      });

      if (!outcome.ok) {
        // Not collapsed into one 400. A malformed or out-of-base DN is the
        // administrator's typo, on the field they just typed; a missing unit
        // or target is a stale page. They need different answers.
        switch (outcome.reason) {
          case 'no_such_unit':
            throw new ProblemError(404, 'not-found', 'Org unit not found');
          case 'no_such_target':
            throw new ProblemError(404, 'not-found', 'Target not found');
          default:
            throw new ProblemError(400, 'bad-request', outcome.message, undefined, {
              reason: outcome.reason,
              errors: [{ path: 'dn', message: outcome.message }],
            });
        }
      }

      reply.code(201);
      return { targetSystemId: body.targetSystemId, dn: outcome.dn, state: outcome.state };
    },
  );

  /**
   * Stop tracking a unit's container on a target.
   *
   * Deletes the ROW and never the container: a container Syntra created and
   * an administrator no longer wants tracked is still a container full of
   * accounts. Removing one is `DELETE /org-units/:id`'s business, and only
   * once it is empty.
   */
  app.delete(
    '/org-units/:id/containers/:targetSystemId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { targetSystemId } = targetParam.parse(request.params);

      const removed = await unmaterialiseOrgUnit(request.tenantId, {
        orgUnitId: id,
        targetSystemId,
        actorUserId: request.session.userId,
      });
      if (!removed) {
        throw new ProblemError(
          404,
          'not-found',
          'This org unit is not materialised on that target',
        );
      }
      reply.code(204);
      return null;
    },
  );

  app.delete(
    '/org-units/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_DELETE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const outcome = await deleteDirectoryOrgUnit(request.tenantId, provider, {
        orgUnitId: id,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      });

      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'not_found':
            throw new ProblemError(404, 'not-found', 'Org unit not found');
          case 'not_empty': {
            const holds = [
              outcome.users > 0
                ? `${outcome.users} user${outcome.users === 1 ? '' : 's'}`
                : null,
              outcome.children > 0
                ? `${outcome.children} child unit${outcome.children === 1 ? '' : 's'}`
                : null,
              outcome.persons > 0
                ? `${outcome.persons} assigned ${outcome.persons === 1 ? 'person' : 'people'}`
                : null,
            ]
              .filter(Boolean)
              .join(', ');
            throw new ProblemError(
              409,
              'org-unit-not-empty',
              'This unit is not empty',
              `it still holds ${holds}; move them before deleting it. A deactivated user still occupies the unit, and deleting a unit people are assigned to would move every one of their accounts back to the account profile's container on the next run`,
            );
          }
          case 'delete_not_enabled':
            throw new ProblemError(
              409,
              'delete-not-enabled',
              'This unit cannot be deleted',
              `${outcome.sourceName} is not configured to let Syntra delete objects in it, and removing only the Syntra record would leave the next sync run free to create the unit again`,
            );
          case 'no_credential':
            throw new ProblemError(
              409,
              'no-credential',
              'This unit cannot be deleted',
              `the bind credential for ${outcome.sourceName} could not be unsealed`,
            );
          case 'directory_failed':
            throw new ProblemError(
              502,
              'directory-failed',
              'The directory refused the delete',
              `${outcome.message}; nothing was changed in Syntra either`,
            );
        }
      }

      return reply.status(204).send();
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
