import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adminFactorParams,
  createUserRequest,
  deactivateUserRequest,
  idParam,
  patchUserRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  createUser,
  deactivateUser,
  reactivateUser,
  listUsers,
  recordEvent,
  removeRecoveryCodes,
  removeTotp,
  revokeOrphanedRecoveryCodes,
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

  app.post(
    '/users/:id/reactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const existing = await tx.user.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'User not found');
        const updated = await reactivateUser(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.reactivate',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          // NO session is restored, and that is not an omission. Deactivation
          // revoked every session and refresh token; reactivation gives back
          // the ability to sign in, not the sessions that were killed.
          payload: { login: existing.login },
        });
        return updated;
      });
    },
  );

  /**
   * Moves a user's password between Syntra and an upstream identity provider.
   *
   * The flag self-service reset reads: an `upstream` user cannot reset a
   * password Syntra does not hold, and is mailed the name recorded here
   * instead. That mail is the only place the distinction is visible — the HTTP
   * response to a reset request is identical either way, because a different
   * response would announce both that the account exists and that it is
   * federated to anyone who can type a login name.
   */
  app.patch(
    '/users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = patchUserRequest.parse(request.body);

      const updated = await request.db(async (tx) => {
        const existing = await tx.user.findUnique({ where: { id } });
        if (!existing) {
          throw new ProblemError(404, 'not-found', 'User not found');
        }

        const user = await tx.user.update({
          where: { id },
          data: {
            ...(body.passwordSource === undefined
              ? {}
              : { passwordSource: body.passwordSource }),
            ...(body.passwordSourceHint === undefined
              ? {}
              : { passwordSourceHint: body.passwordSourceHint }),
          },
        });
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.update',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { passwordSource: user.passwordSource },
        });
        return user;
      });

      return {
        id: updated.id,
        passwordSource: updated.passwordSource,
        passwordSourceHint: updated.passwordSourceHint,
      };
    },
  );

  /**
   * Takes a factor off a user.
   *
   * The way back in for someone who lost their phone, and the way an
   * administrator revokes a factor an attacker enrolled. It writes its own
   * audit event in the same transaction as the removal, naming the
   * administrator: a factor that disappears with nothing to show who removed
   * it is indistinguishable from one the attacker removed.
   */
  app.delete(
    '/users/:id/factors/:type',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id, type } = adminFactorParams.parse(request.params);

      const orphanedCodes = await request.db(async (tx) => {
        if (type === 'totp') await removeTotp(tx, id);
        else if (type === 'recovery_code') await removeRecoveryCodes(tx, id);
        else await tx.webAuthnCredential.deleteMany({ where: { userId: id } });

        // Recovery codes are a way back in when a real factor is lost, not a
        // factor of their own — which is why issuing them requires holding
        // one. Taking the last real factor away and leaving the codes reaches
        // the state that gate exists to prevent, by another door: a
        // `require_mfa` rule stays satisfied by a printed page forever, and
        // the forced-enrolment path is never reached.
        const revoked = await revokeOrphanedRecoveryCodes(tx, id);

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.removed',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            factor: type,
            by: 'administrator',
            // Named, so a user who finds their codes stopped working can be
            // told why by someone reading the log.
            recoveryCodesRevoked: revoked,
          },
        });
        return revoked;
      });

      return reply.status(200).send({ recoveryCodesRevoked: orphanedCodes });
    },
  );
}
