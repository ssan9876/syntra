import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountProfileRequestSchema, idParam } from '@syntra/contracts';
import {
  PERMISSIONS,
  TargetNotFoundError,
  previewAccountProfile,
  previewContainerForFacts,
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

/**
 * Facts as typed into a form, rather than a person who exists.
 *
 * Every field optional but the two names, because this is answered WHILE
 * somebody is filling the form in: half-typed is the normal state, and a
 * preview that demanded a complete contract would only appear at the moment it
 * had stopped being useful.
 */
const containerPreviewRequest = z
  .object({
    givenName: z.string().max(128).default(''),
    familyName: z.string().max(128).default(''),
    department: z.string().max(256).optional(),
    jobTitle: z.string().max(256).optional(),
    costCentre: z.string().max(128).optional(),
    employer: z.string().max(256).optional(),
    location: z.string().max(256).optional(),
    businessEmail: z.string().max(320).optional(),
    personalEmail: z.string().max(320).optional(),
  })
  .strict();

export async function registerAdminProfileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/targets/:id/profile',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
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
      const { id } = idParam.parse(request.params);
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
      const { id } = idParam.parse(request.params);
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

  /**
   * Where an account WOULD be created, from facts typed into a form.
   *
   * Distinct from the preview above, which takes a `personId` and is for
   * checking a profile against somebody who exists. The onboarding form has no
   * person yet — that is the point of it — and the question it needs answered
   * is "which container will this department put them in", while the
   * department is still free to correct.
   *
   * `provision.read`, not `provision.manage`. Asking where an account would go
   * is a read; changing a container template is not. The onboarding page
   * already needs `provision.read` to list targets at all, so the hint costs
   * the caller no permission they did not already need.
   */
  app.post(
    '/targets/:id/profile/preview-container',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const facts = containerPreviewRequest.parse(request.body ?? {});

      const preview = await previewContainerForFacts(request.tenantId, id, facts);
      // One 404 for both "no such target" and "no profile on it". They are the
      // same answer to the caller — there is no container to name — and the
      // form shows nothing either way rather than raising configuration
      // somebody did not come here to do.
      if (!preview) {
        throw new ProblemError(
          404,
          'not-found',
          'No container to preview',
          'this target has no account profile, so there is no template to render',
        );
      }
      return preview;
    },
  );
}
