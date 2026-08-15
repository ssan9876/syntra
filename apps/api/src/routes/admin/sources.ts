import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  createSourceRequest,
  deleteSourceQuery,
  idParam,
  setMappingsRequest,
  updateSourceRequest,
} from '@syntra/contracts';
import { ldapConnector } from '@syntra/connectors';
import {
  PERMISSIONS,
  SourceOwnsObjectsError,
  applySourceSchedule,
  createSource,
  deleteSource,
  listSources,
  localMasterKeyProvider,
  mappingsFor,
  previewRun,
  recordEvent,
  removeSourceSchedule,
  setMappings,
  sourceWithPassword,
  updateSource,
  type MappingRule,
  type SchedulableSource,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface SourceRouteOptions {
  masterKey: Buffer;
  /**
   * Late-bound on purpose. The scheduler talks to pg-boss and is started
   * after the app is built — and it is allowed to fail to start without
   * keeping the API down — so these routes ask for it when they need it
   * rather than being handed one at registration.
   */
  scheduler?: () => Scheduler | null;
}

export async function registerAdminSourceRoutes(
  app: FastifyInstance,
  options: SourceRouteOptions,
): Promise<void> {
  const provider = localMasterKeyProvider(options.masterKey);

  /**
   * Brings the scheduler into line with a source that just changed.
   *
   * Without this a source created with a cron expression was not scheduled
   * until the process restarted, since `scheduleAllSyncSources` runs once at
   * boot and nothing else touched the scheduler.
   *
   * A scheduling failure is logged, not raised. The mutation has already
   * committed by the time this runs, so a 500 here would report a failure for
   * work that succeeded, and the caller would have no way to tell which half
   * happened. The same reasoning `scheduleAllSyncSources` uses at boot: an
   * unscheduled source is worse than a scheduled one and better than a lie
   * about what was saved.
   */
  const reschedule = async (
    request: FastifyRequest,
    source: SchedulableSource,
  ): Promise<void> => {
    const scheduler = options.scheduler?.();
    if (!scheduler) return;
    try {
      await applySourceSchedule(scheduler, request.tenantId, source);
    } catch (cause) {
      request.log.error(
        { err: cause, sourceId: source.id },
        'the source was saved but could not be scheduled',
      );
    }
  };

  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/sources',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => ({ sources: await request.db((tx) => listSources(tx)) }),
  );

  app.post(
    '/sources',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const body = createSourceRequest.parse(request.body);

      const source = await request.db(async (tx) => {
        // The same pre-check `PATCH` does, for the same reason: without it the
        // unique index on (tenantId, name) surfaces as a bare 500, and an
        // administrator retyping a name they already used gets no idea why.
        // Not a substitute for the constraint — two simultaneous creates can
        // still race past this under READ COMMITTED, and the index is what
        // makes that a failed request rather than two sources with one name.
        const clash = await tx.directorySource.findFirst({
          where: { name: body.name },
        });
        if (clash) {
          throw new ProblemError(
            409,
            'conflict',
            'Conflict',
            `a source is already named ${body.name}`,
          );
        }

        const created = await createSource(tx, provider, body);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'source.create',
          targetType: 'DirectorySource',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: created.name },
        });
        return created;
      });

      // Immediately, not at the next restart.
      await reschedule(request, source);

      // The row carries only the secret's name; the password itself is in the
      // vault and is never echoed.
      return reply.status(201).send(source);
    },
  );

  app.patch(
    '/sources/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = updateSourceRequest.parse(request.body);

      const source = await request.db(async (tx) => {
        if (body.name !== undefined) {
          const clash = await tx.directorySource.findFirst({
            where: { name: body.name, id: { not: id } },
          });
          if (clash) {
            throw new ProblemError(
              409,
              'conflict',
              'Conflict',
              `a source is already named ${body.name}`,
            );
          }
        }

        let updated;
        try {
          updated = await updateSource(tx, provider, id, body);
        } catch (cause) {
          // `ZodError` only, and deliberately narrow. The one failure in here
          // that is the caller's mistake is a rejected connection
          // configuration — a TLS mode contradicting the URL scheme, a missing
          // search base — and that is the only thing `ldapConfigSchema.parse`
          // throws. Everything else this can raise is ours: a vault failure, a
          // P2002 from the name-clash race the pre-check above cannot close
          // under READ COMMITTED, a dropped connection. Repeating any of those
          // back as a 400 with `cause.message` as the RFC 9457 `detail` both
          // misstates whose fault it is and leaks whatever the message
          // happened to carry, against this API's own stated policy (see
          // plugins/problem-json.ts). Rethrown, they reach the error handler,
          // which logs them and tells the client nothing but 500.
          if (cause instanceof ZodError) {
            throw new ProblemError(
              400,
              'invalid-config',
              'Invalid source configuration',
              cause.issues.map((i) => i.message).join('; '),
            );
          }
          throw cause;
        }
        if (!updated) throw new ProblemError(404, 'not-found', 'Source not found');

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'source.update',
          targetType: 'DirectorySource',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          // The changed field names, never their values: `config` holds a bind
          // DN and `bindPassword` a credential, and the audit log is readable
          // by anyone holding audit.read.
          payload: { fields: Object.keys(body).sort() },
        });
        return updated;
      });

      await reschedule(request, source);

      return source;
    },
  );

  app.delete(
    '/sources/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { confirm } = deleteSourceQuery.parse(request.query);

      await request.db(async (tx) => {
        let released;
        try {
          released = await deleteSource(tx, id, { confirm });
        } catch (cause) {
          if (cause instanceof SourceOwnsObjectsError) {
            // 409, and the counts, because this is not a refusal to act — it
            // is the same act awaiting a decision, and the decision needs the
            // numbers behind it.
            throw new ProblemError(
              409,
              'source-owns-directory-objects',
              'Confirmation required',
              cause.message,
              { owned: cause.counts },
            );
          }
          throw cause;
        }
        if (!released) throw new ProblemError(404, 'not-found', 'Source not found');

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'source.delete',
          targetType: 'DirectorySource',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          // What was deactivated is the part of this worth being able to look
          // up later; the source row itself is gone.
          payload: { deactivated: released },
        });
      });

      const scheduler = options.scheduler?.();
      if (scheduler) {
        try {
          await removeSourceSchedule(scheduler, request.tenantId, id);
        } catch (cause) {
          request.log.error(
            { err: cause, sourceId: id },
            'the source was deleted but its schedule could not be removed',
          );
        }
      }

      return reply.status(204).send();
    },
  );

  app.put(
    '/sources/:id/mappings',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { rules } = setMappingsRequest.parse(request.body);

      await request.db(async (tx) => {
        try {
          await setMappings(tx, id, rules as MappingRule[]);
        } catch (cause) {
          throw new ProblemError(
            400,
            'invalid-mappings',
            'Invalid mappings',
            cause instanceof Error ? cause.message : undefined,
          );
        }
      });

      return { rules: await request.db((tx) => mappingsFor(tx, id)) };
    },
  );

  app.post(
    '/sources/:id/test',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const config = await request.db((tx) =>
        sourceWithPassword(tx, provider, id),
      );
      if (!config) throw new ProblemError(404, 'not-found', 'Source not found');

      // A failed connection is a result, not a server error: the operator
      // needs the message, not a 500.
      return ldapConnector.test(config);
    },
  );

  app.post(
    '/sources/:id/run',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      // previewRun takes a tenantId, not a caller's transaction: it opens its
      // own transactions internally, one per phase, so it can durably mark a
      // failed run even after the read/diff work has aborted a transaction.
      return previewRun(request.tenantId, provider, id);
    },
  );
}
