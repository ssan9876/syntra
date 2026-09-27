import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deletePersonRequest, idParam } from '@syntra/contracts';
import {
  PERMISSIONS,
  PersonDeletionRefusedError,
  STEP_UP_MAX_AGE_MS,
  hardDeletePerson,
  isRecentElevation,
  personFullName,
  recordEvent,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * `DELETE /persons/:id`: hard-deleting a person. See
 * `identity/person-deletion.ts` for what goes and what stays.
 *
 * Its own module, beside `persons.ts`, and the strictest gate a delete here
 * has: `person.purge` (the built-in Data deletion role only), a console
 * session elevated within `STEP_UP_MAX_AGE_MS`, never a machine token
 * (`TOKEN_DENIED_OPERATIONS`), a reason, and the full name typed back.
 *
 * Refusals about a real person of this tenant are audited as failures, with
 * ids and a code only. A missing or foreign id is not audited.
 */
export async function registerAdminPersonDeleteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  const refuse = async (request: FastifyRequest, personId: string, refusal: string) => {
    await request.db(async (tx) => {
      const exists = await tx.person.findUnique({ where: { id: personId }, select: { id: true } });
      if (!exists) return;
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'person.purged',
        targetType: 'Person',
        targetId: personId,
        outcome: 'failure',
        sourceIp: request.ip,
        payload: { refusal },
      });
    });
  };

  app.delete(
    '/persons/:id',
    { preHandler: requirePermission(PERMISSIONS.PERSON_PURGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = deletePersonRequest.parse(request.body ?? {});

      // A token has no elevation to be recent.
      if (request.session.viaToken || !isRecentElevation(request.session)) {
        await refuse(request, id, 'step_up_required');
        throw new ProblemError(
          403,
          'step-up-required',
          'Confirm it is you first',
          `Deleting a person needs a console sign-in from the last ${STEP_UP_MAX_AGE_MS / 60_000} minutes. Elevate again, then retry.`,
        );
      }

      const outcome = await request.db(async (tx) => {
        const person = await tx.person.findUnique({
          where: { id },
          select: { givenName: true, familyName: true },
        });
        if (!person) return { ok: false as const, code: 'not-found' as const, message: 'Person not found.' };
        // Exact, give or take surrounding whitespace, and case-sensitive.
        if (body.confirm.trim() !== personFullName(person).trim()) {
          return { ok: false as const, code: 'confirm-mismatch' as const, message: '' };
        }
        try {
          return {
            ok: true as const,
            counts: await hardDeletePerson(tx, id, {
              actorUserId: request.session.userId,
              reason: body.reason,
              sourceIp: request.ip,
            }),
          };
        } catch (cause) {
          if (cause instanceof PersonDeletionRefusedError) {
            return { ok: false as const, code: cause.code, message: cause.message };
          }
          throw cause;
        }
      });

      if (outcome.ok) return reply.status(204).send();

      switch (outcome.code) {
        case 'not-found':
          throw new ProblemError(404, 'not-found', 'Person not found');
        case 'confirm-mismatch':
          // Never the text that was typed: it can be anything pasted into the wrong box.
          await refuse(request, id, 'confirm_mismatch');
          throw new ProblemError(
            400,
            'confirm-mismatch',
            'Name does not match',
            "Type the person's full name exactly as shown.",
            { errors: [{ path: 'confirm', message: 'Type the full name exactly as shown' }] },
          );
        case 'active':
          await refuse(request, id, 'active');
          throw new ProblemError(409, 'person-active', 'Person is active', outcome.message);
        case 'open-privacy-case':
          await refuse(request, id, 'open_privacy_case');
          throw new ProblemError(409, 'open-privacy-case', 'Open privacy case', outcome.message);
      }
    },
  );
}
