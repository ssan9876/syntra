import type { FastifyInstance } from 'fastify';
import {
  assignApplicationRequest,
  assignmentParams,
  createApplicationRequest,
  idParam,
  updateApplicationRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  assignApplication,
  createApplication,
  findApplication,
  listApplications,
  listAssignments,
  recordEvent,
  unassignApplication,
  updateApplication,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * Drops explicit `undefined` values from a parsed partial request body.
 *
 * `updateApplicationRequest` is `createApplicationRequest.partial()`, so zod
 * infers `name` as `string | undefined` even though the service's
 * `Partial<CreateApplicationInput>` declares it as an omittable `string` —
 * `exactOptionalPropertyTypes` treats "present and undefined" as a different
 * thing from "absent", and only the latter satisfies the service's type. The
 * omission is also the right runtime behaviour: an update body that did not
 * mention a field must leave it alone, not overwrite it with undefined.
 */
function withoutUndefined<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export async function registerAdminApplicationRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/applications',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) },
    async (request) => ({
      applications: await request.db((tx) => listApplications(tx)),
    }),
  );

  app.post(
    '/applications',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const body = createApplicationRequest.parse(request.body);

      const created = await request.db(async (tx) => {
        let application;
        try {
          application = await createApplication(tx, body);
        } catch (cause) {
          throw new ProblemError(
            409,
            'slug-taken',
            'That slug is already used',
            cause instanceof Error ? cause.message : undefined,
          );
        }
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.create',
          targetType: 'Application',
          targetId: application.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: application.slug, name: application.name },
        });
        return application;
      });

      return reply.status(201).send(created);
    },
  );

  app.put(
    '/applications/:id',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = updateApplicationRequest.parse(request.body);

      return request.db(async (tx) => {
        const existing = await findApplication(tx, id);
        if (!existing) throw new ProblemError(404, 'not-found', 'Application not found');

        const updated = await updateApplication(tx, id, withoutUndefined(body));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.update',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: updated.slug, status: updated.status },
        });
        return updated;
      });
    },
  );

  app.get(
    '/applications/:id/assignments',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return { assignments: await request.db((tx) => listAssignments(tx, id)) };
    },
  );

  app.post(
    '/applications/:id/assignments',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const subject = assignApplicationRequest.parse(request.body);

      await request.db(async (tx) => {
        const application = await findApplication(tx, id);
        if (!application) throw new ProblemError(404, 'not-found', 'Application not found');

        await assignApplication(tx, id, subject);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.assign',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { subjectType: subject.type, subjectId: subject.id },
        });
      });

      return reply.status(201).send({ ok: true });
    },
  );

  app.delete(
    '/applications/:id/assignments/:assignmentId',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const { id, assignmentId } = assignmentParams.parse(request.params);

      await request.db(async (tx) => {
        await unassignApplication(tx, assignmentId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.unassign',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { assignmentId },
        });
      });

      return reply.status(204).send();
    },
  );
}
