import type { FastifyInstance } from 'fastify';
import {
  idParam,
  patchRoleBody,
  roleAssignmentBody,
  roleAssignmentParams,
  roleAssignmentQuery,
  roleBody,
} from '@syntra/contracts';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  RoleRefusedError,
  assertPermissionNames,
  assignRole,
  countHoldersOf,
  createRole,
  deleteRole,
  listRolesWithAssignmentCounts,
  recordEvent,
  revokeRole,
  updateRole,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * The role surface, which did not exist at all.
 *
 * `Role.permissions` was written once by the seed and never again: no
 * migration, no backfill, no API. The catalogue grew in six later commits, so
 * an upgraded installation's Owner got 403 on every new module -- the Updates
 * page most visibly, since `deployment.manage` was added after every existing
 * deployment had already been seeded -- and the only remedy was raw SQL
 * against the `Role` table. `rbac.manage` itself gated nothing, because
 * nothing consulted it.
 *
 * Guarded by `rbac.manage`, which finally means something. Every mutation is
 * audited in the same transaction as the write, like every other admin route
 * in this directory.
 */
export async function registerAdminRoleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  /**
   * Refuses to be the change that locks the installation out of itself.
   *
   * Run INSIDE the writing transaction, after the write, so it sees the state
   * the change actually produced rather than a prediction of it -- and so
   * throwing rolls the write back. Predicting the post-change holder set in
   * memory would mean reimplementing `hasPermission`'s rules here, and the two
   * would disagree the first time one of them changed.
   *
   * Only `rbac.manage` is guarded. Every other permission can be taken away
   * and given back by somebody holding this one; this is the only one whose
   * absence is unrecoverable without a database client, which is exactly the
   * state this module was built to end.
   */
  const guardRbac = async (tx: Parameters<typeof countHoldersOf>[0]): Promise<void> => {
    if ((await countHoldersOf(tx, PERMISSIONS.RBAC_MANAGE)) > 0) return;
    throw new RoleRefusedError(
      'would-strand-rbac',
      'That would leave nobody able to administer roles, and there is no way back from it but a database client. Give somebody else rbac.manage first.',
    );
  };

  /** Domain refusals become 4xx problems carrying their code. */
  const asProblem = (cause: unknown): never => {
    if (cause instanceof RoleRefusedError) {
      const status = cause.code === 'unknown-permission' ? 422 : 409;
      throw new ProblemError(status, cause.code, 'Cannot be saved', cause.message);
    }
    throw cause;
  };

  app.get(
    '/roles',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request) => ({
      // The CATALOGUE travels with the list. The console renders a checkbox
      // per permission and has no other way to know what they are -- and a
      // hard-coded copy in the web bundle is the second definition this
      // module exists to avoid.
      catalog: [...ALL_PERMISSIONS],
      roles: await request.db((tx) => listRolesWithAssignmentCounts(tx)),
    }),
  );

  app.post(
    '/roles',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const body = roleBody.parse(request.body);
      try {
        const created = await request.db(async (tx) => {
          const role = await createRole(
            tx,
            body.name,
            assertPermissionNames(body.permissions),
            body.description === null ? {} : { description: body.description },
          );
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'rbac.role_created',
            targetType: 'Role',
            targetId: role.id,
            outcome: 'success',
            sourceIp: request.ip,
            payload: { name: role.name, permissions: role.permissions },
          });
          return role;
        });
        return reply.status(201).send(created);
      } catch (cause) {
        return asProblem(cause);
      }
    },
  );

  app.patch(
    '/roles/:id',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = patchRoleBody.parse(request.body);
      try {
        await request.db(async (tx) => {
          await updateRole(tx, id, body);
          await guardRbac(tx);
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'rbac.role_updated',
            targetType: 'Role',
            targetId: id,
            outcome: 'success',
            sourceIp: request.ip,
            // The resulting state, not the diff of a form nobody can see
            // later. Same rule the tenant settings route follows.
            payload: { changed: Object.keys(body), ...body },
          });
        });
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );

  app.delete(
    '/roles/:id',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      try {
        await request.db(async (tx) => {
          const role = await tx.role.findUniqueOrThrow({ where: { id } });
          await deleteRole(tx, id);
          await guardRbac(tx);
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'rbac.role_deleted',
            targetType: 'Role',
            targetId: id,
            outcome: 'success',
            sourceIp: request.ip,
            payload: { name: role.name, permissions: role.permissions },
          });
        });
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/roles/:id/assignments',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = roleAssignmentBody.parse(request.body);
      await request.db(async (tx) => {
        // `findUnique` and an explicit refusal, not `findUniqueOrThrow`.
        // `problem-json` deliberately does not relabel a Prisma error, so the
        // throwing form answered 500 for a well-formed id that names nothing —
        // a stale row, a copied uuid — on the one route whose job is checking
        // exactly these two ids. Which of them was wrong is the whole content
        // of the answer, so they are refused separately.
        const role = await tx.role.findUnique({ where: { id }, select: { id: true } });
        if (!role) throw new ProblemError(404, 'not-found', 'Role not found');

        const user = await tx.user.findUnique({
          where: { id: body.userId },
          select: { id: true },
        });
        if (!user) throw new ProblemError(404, 'not-found', 'User not found');

        await assignRole(tx, body.userId, id, body.scopeOrgUnitId ?? undefined);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'rbac.role_assigned',
          targetType: 'User',
          targetId: body.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { roleId: id, scopeOrgUnitId: body.scopeOrgUnitId },
        });
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    '/roles/:id/assignments/:userId',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const { id, userId } = roleAssignmentParams.parse(request.params);
      // Which grant, where somebody holds the role more than once. Absent is
      // every scope, which is what the path alone has always meant.
      //
      // It could not be said before, and the old comment here claimed a
      // caller wanting to keep one department's grant "does it by
      // re-assigning" -- but assigning only ever adds, so withdrawing one of
      // two grants was not expressible at all. `revokeRole` has taken this
      // argument since it was written; only this layer never passed it.
      const { scopeOrgUnitId } = roleAssignmentQuery.parse(request.query);
      try {
        await request.db(async (tx) => {
          await revokeRole(tx, userId, id, scopeOrgUnitId);
          // Unchanged by the scope, and deliberately: `countHoldersOf` counts
          // UNSCOPED holders only, so withdrawing a tenant-wide grant is
          // refused even where a scoped one survives it. Authority over one
          // department cannot restore authority over the tenant.
          await guardRbac(tx);
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'rbac.role_revoked',
            targetType: 'User',
            targetId: userId,
            outcome: 'success',
            sourceIp: request.ip,
            // Recorded even when absent: "every scope" and "the Cardiology
            // one" are different acts, and a payload that omits the field
            // leaves the log unable to say which happened.
            payload: { roleId: id, scopeOrgUnitId: scopeOrgUnitId ?? null },
          });
        });
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );
}
