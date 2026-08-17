import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountProfileRequestSchema } from '@syntra/contracts';
import {
  PERMISSIONS,
  TargetNotFoundError,
  previewAccountProfile,
  upsertAccountProfile,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const previewRequest = z
  .object({
    profile: accountProfileRequestSchema,
    personId: z.string().uuid(),
  })
  .strict();

export async function registerAdminProfileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/targets/:id/profile',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = request.params as { id: string };
      const profile = await request.db((tx) =>
        tx.accountProfile.findFirst({ where: { targetSystemId: id } }),
      );
      if (!profile) throw new ProblemError(404, 'not-found', 'No account profile yet');
      return profile;
    },
  );

  app.put(
    '/targets/:id/profile',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = accountProfileRequestSchema.parse(request.body);
      try {
        // Parsed twice on purpose: the contract schema is a transport shape,
        // and `accountProfileSchema` inside `upsertAccountProfile` is what
        // refuses `userAccountControl`, `member` and `distinguishedName` —
        // the attributes `update_account` writes and the guard does not count.
        // A ZodError from either reaches the handler as a 400 with the
        // offending field named.
        await upsertAccountProfile(request.tenantId, request.session.userId, id, body);
      } catch (cause) {
        if (cause instanceof TargetNotFoundError) {
          throw new ProblemError(404, 'not-found', 'Target not found');
        }
        throw cause;
      }
      return reply.code(204).send();
    },
  );

  app.post(
    '/targets/:id/profile/preview',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = request.params as { id: string };
      // Parsed, both halves. A template language nobody can try is a template
      // language everybody gets wrong, and a preview that accepts anything is
      // a preview of something other than what would be saved —
      // `previewAccountProfile` re-parses with the storage schema for exactly
      // that reason.
      const body = previewRequest.parse(request.body);
      const person = await request.db((tx) =>
        tx.person.findUnique({ where: { id: body.personId }, select: { id: true } }),
      );
      if (!person) throw new ProblemError(404, 'not-found', 'Person not found');
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: { id: true } }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      return previewAccountProfile(request.tenantId, id, body.profile, body.personId);
    },
  );
}
