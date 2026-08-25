import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adminFactorParams,
  createUserRequest,
  deactivateUserRequest,
  idParam,
  patchUserDetailsRequest,
  patchUserRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  createUser,
  deactivateDirectoryUser,
  deleteDirectoryUser,
  reactivateDirectoryUser,
  issuePasswordSetup,
  listUsers,
  localMasterKeyProvider,
  recordEvent,
  removeRecoveryCodes,
  removeTotp,
  revokeOrphanedRecoveryCodes,
  type DeactivateOutcome,
  type IssueSetupOutcome,
  type UserStatus,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const listQuery = z.object({
  status: z.enum(['active', 'inactive']).optional(),
});

export interface AdminUserRouteOptions {
  /** Unseals a directory source's bind credential for a write-back. */
  masterKey: Buffer;
  /**
   * Composes the setup link, so both password flows land on the one route the
   * reset mail already points at.
   */
  publicUrl: string;
}

/**
 * Turns a refusal from the write-back service into the HTTP answer for it.
 *
 * Separate from the routes because deactivate and reactivate refuse for
 * exactly the same reasons, and two copies of this mapping is how one of them
 * ends up answering 500 for a case the other explains.
 */
function raiseIfRefused(outcome: DeactivateOutcome): void {
  if (outcome.ok) return;
  switch (outcome.reason) {
    case 'not_found':
      throw new ProblemError(404, 'not-found', 'User not found');
    case 'writeback_not_enabled':
      // 409, not 403: the caller has the permission, the configuration does
      // not allow the write. Refusing rather than doing it locally is
      // deliberate -- a local-only status change on a directory-managed
      // account is undone by the next sync run, which is a button that
      // appears to work and does not.
      throw new ProblemError(
        409,
        'writeback-not-enabled',
        'Write-back is not enabled for this source',
        `This account is owned by ${outcome.sourceName}, and Syntra is not ` +
          `permitted to change accounts there. Enable write-back on that ` +
          `source, or disable the account in the directory itself.`,
      );
    case 'no_credential':
      throw new ProblemError(
        500,
        'source-credential-missing',
        'The source credential could not be read',
        `The stored bind credential for ${outcome.sourceName} could not be ` +
          `unsealed, so nothing was changed.`,
      );
    case 'directory_failed':
      // 502: an upstream system answered, and said no.
      throw new ProblemError(
        502,
        'directory-write-failed',
        'The directory refused the change',
        `Nothing was changed. The directory reported: ${outcome.message}.`,
      );
  }
}

export async function registerAdminUserRoutes(
  app: FastifyInstance,
  options: AdminUserRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);

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

      const outcome = await deactivateDirectoryUser(request.tenantId, provider, {
        userId: id,
        reason,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      });
      raiseIfRefused(outcome);
      return request.db((tx) => tx.user.findUniqueOrThrow({ where: { id } }));
    },
  );

  app.post(
    '/users/:id/reactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      // NO session is restored, and that is not an omission. Deactivation
      // revoked every session and refresh token; reactivation gives back the
      // ability to sign in, not the sessions that were killed.
      const outcome = await reactivateDirectoryUser(request.tenantId, provider, {
        userId: id,
        reason: 'reactivated by an administrator',
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      });
      raiseIfRefused(outcome);
      return request.db((tx) => tx.user.findUniqueOrThrow({ where: { id } }));
    },
  );

  /**
   * Deletion, where everything else in this directory deactivates.
   *
   * Offered because a directory that can never forget anything becomes its own
   * problem, and gated three ways because it is the one operation here that
   * doing the opposite does not undo: a permission of its own, a per-source
   * flag of its own, and a confirmation in the console that makes the reader
   * type the login.
   *
   * The Person and the audit trail survive it. See `deleteDirectoryUser`.
   */
  app.delete(
    '/users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_DELETE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const outcome = await deleteDirectoryUser(request.tenantId, provider, {
        userId: id,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      });

      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'not_found':
            throw new ProblemError(404, 'not-found', 'User not found');
          case 'delete_not_enabled':
            // 409, not 403: the caller HAS the permission and the
            // configuration does not allow the write. The detail says why
            // deleting the Syntra row alone would be worse than refusing.
            throw new ProblemError(
              409,
              'delete-not-enabled',
              'This account cannot be deleted',
              `${outcome.sourceName} is not configured to let Syntra delete objects in it, and removing only the Syntra record would leave the next sync run free to create the account again`,
            );
          case 'no_credential':
            throw new ProblemError(
              409,
              'no-credential',
              'This account cannot be deleted',
              `the bind credential for ${outcome.sourceName} could not be unsealed`,
            );
          case 'directory_failed':
            // 502: Syntra worked, the directory refused. Nothing was changed
            // on either side, which the message says so nobody goes looking
            // for a half-finished delete.
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
   * Mints a password-setup link for a user who has no password.
   *
   * The gap this fills: self-service change needs the password they do not
   * have, and the reset flow needs a mailbox a joiner may not have yet, so
   * before this there was no way to give anybody a first password.
   *
   * The link is returned rather than mailed, because mailing does not serve
   * the case it exists for. It is a bearer credential and is bounded by two
   * things: a 24-hour expiry, and the audit event `issuePasswordSetup` writes
   * naming the administrator who minted it.
   */
  app.post(
    '/users/:id/password-setup',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      let issued: IssueSetupOutcome;
      try {
        issued = await request.db((tx) =>
          issuePasswordSetup(tx, {
            userId: id,
            actorUserId: request.session.userId,
            sourceIp: request.ip,
          }),
        );
      } catch (cause) {
        // Two issuances for the same user at once: one wins the partial unique
        // index `password_reset_token_one_live` and the other violates it.
        //
        // The reset path swallows this and sends nothing, because surfacing it
        // there builds an account-existence oracle out of an error page. That
        // argument buys nothing against a caller who already holds
        // `directory.write`, and swallowing it here would answer 200 with a
        // link that was invalidated before it reached the caller. A 409 says
        // "that raced, do it again", which is true and actionable.
        if ((cause as { code?: string }).code === 'P2002') {
          throw new ProblemError(
            409,
            'conflict',
            'Setup link already being created',
            'Another setup link was being created for this user at the same time. Try again.',
          );
        }
        throw cause;
      }

      if (!issued.ok) {
        if (issued.reason === 'unknown_user') {
          throw new ProblemError(404, 'not-found', 'User not found');
        }
        const user = await request.db((tx) =>
          tx.user.findUnique({ where: { id }, select: { passwordSourceHint: true } }),
        );
        throw new ProblemError(
          409,
          'password-source-not-local',
          'Password not held here',
          `This user's password is held by ${user?.passwordSourceHint ?? 'an external identity provider'}, so Syntra cannot set it.`,
        );
      }

      return {
        url: `${options.publicUrl.replace(/\/$/, '')}/reset-password?token=${issued.token}`,
        expiresAt: issued.expiresAt.toISOString(),
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

  /**
   * The user's own details: what they are called, where mail reaches them, and
   * where they sit in the organization.
   *
   * Separate from `PATCH /users/:id`, which is about where the PASSWORD lives
   * and nothing else. Folding the two together would put a field that changes
   * how authentication works in the same request as a display-name fix, and
   * the audit rows would stop distinguishing them.
   *
   * `login` is not editable here. It is what somebody types to sign in and what
   * the audit trail is read by; changing it is an account migration, not an
   * edit.
   *
   * A source-owned account is refused: the next sync run reads these fields
   * from the directory and would overwrite the change.
   */
  app.patch(
    '/users/:id/details',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = patchUserDetailsRequest.parse(request.body);

      return request.db(async (tx) => {
        const existing = await tx.user.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'User not found');
        if (existing.sourceId) {
          throw new ProblemError(
            409,
            'source-owned',
            'Managed by a directory source',
            'This account is read from a directory source, and the next sync run would overwrite the change. Edit it where it comes from.',
          );
        }

        if (body.orgUnitId !== undefined && body.orgUnitId !== null) {
          const unit = await tx.orgUnit.findUnique({ where: { id: body.orgUnitId } });
          if (!unit) throw new ProblemError(404, 'not-found', 'Org unit not found');
        }

        const updated = await tx.user.update({
          where: { id },
          data: {
            ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
            ...(body.email === undefined ? {} : { email: body.email }),
            ...(body.orgUnitId === undefined ? {} : { orgUnitId: body.orgUnitId }),
          },
        });
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.updateDetails',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            from: {
              displayName: existing.displayName,
              email: existing.email,
              orgUnitId: existing.orgUnitId,
            },
            to: {
              displayName: updated.displayName,
              email: updated.email,
              orgUnitId: updated.orgUnitId,
            },
          },
        });
        return {
          id: updated.id,
          login: updated.login,
          displayName: updated.displayName,
          email: updated.email,
          orgUnitId: updated.orgUnitId,
        };
      });
    },
  );
}
