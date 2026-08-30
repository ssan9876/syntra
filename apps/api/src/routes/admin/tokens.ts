import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParam, issueApiTokenRequest } from '@syntra/contracts';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  issueApiToken,
  listApiTokens,
  recordEvent,
  revokeApiToken,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

const tokenParams = z.object({
  id: z.string().uuid(),
  tokenId: z.string().uuid(),
});

/**
 * Machine credentials for a service account.
 *
 * Guarded by `token.manage` rather than `directory.write`: issuing a
 * credential that ACTS AS an account is a different authority from editing
 * that account, and the existing `directory.write` / `directory.delete` split
 * is the precedent.
 *
 * A machine token cannot reach any of these routes, whatever it holds — see
 * `TOKEN_DENIED_ROUTES`. A credential that can mint credentials is a
 * credential whose revocation does not end its authority.
 */
export async function registerAdminTokenRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/users/:id/tokens',
    { preHandler: requirePermission(PERMISSIONS.TOKEN_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const tokens = await request.db((tx) => listApiTokens(tx, id));
      return { tokens };
    },
  );

  app.post(
    '/users/:id/tokens',
    { preHandler: requirePermission(PERMISSIONS.TOKEN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = issueApiTokenRequest.parse(request.body);

      // Against the real permission list. An unknown scope would be a token
      // that silently grants nothing, met later as a 403 nobody can explain.
      const known = new Set<string>(ALL_PERMISSIONS);
      const unknown = body.scopes.filter((scope) => !known.has(scope));
      if (unknown.length > 0) {
        throw new ProblemError(
          400,
          'unknown-scope',
          'Unknown scope',
          `Not a permission: ${unknown.join(', ')}`,
        );
      }

      const issued = await request.db(async (tx) => {
        const account = await tx.user.findUnique({ where: { id }, select: { id: true } });
        if (!account) throw new ProblemError(404, 'not-found', 'User not found');

        const result = await issueApiToken(tx, {
          userId: id,
          name: body.name,
          scopes: body.scopes,
          expiresAt: body.expiresAt === null ? null : new Date(body.expiresAt),
          createdBy: request.session.userId,
        });

        // The name, the scopes and the expiry. NEVER the token: an audit row
        // is read by more people, and kept longer, than the credential itself.
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'api_token.issued',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            tokenId: result.id,
            name: body.name,
            scopes: body.scopes,
            expiresAt: body.expiresAt,
          },
        });

        return result;
      });

      // The one and only time this value is returned. There is no route that
      // reads it back, and no column it could be read back from.
      return reply.code(201).send({
        id: issued.id,
        token: issued.token,
        expiresAt: issued.expiresAt?.toISOString() ?? null,
      });
    },
  );

  app.delete(
    '/users/:id/tokens/:tokenId',
    { preHandler: requirePermission(PERMISSIONS.TOKEN_MANAGE) },
    async (request, reply) => {
      const { id, tokenId } = tokenParams.parse(request.params);

      await request.db(async (tx) => {
        // Scoped to the account in the path, so a token id alone is not a
        // capability to revoke anything in the tenant.
        const owned = await tx.apiToken.findFirst({
          where: { id: tokenId, userId: id, revokedAt: null },
          select: { id: true, name: true },
        });
        if (!owned) throw new ProblemError(404, 'not-found', 'Token not found');

        await revokeApiToken(tx, tokenId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'api_token.revoked',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { tokenId, name: owned.name },
        });
      });

      return reply.code(204).send();
    },
  );
}
