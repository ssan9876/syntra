import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  acceptHostKeyRequest,
  applyImportRunRequest,
  createPersonSourceRequest,
  idParam,
  setPersonMappingsRequest,
  updatePersonSourceRequest,
} from '@syntra/contracts';
import { UnknownPersonSourceTypeError, personSourceConnectorFor } from '@syntra/connectors';
import {
  ASSIGNABLE_CONTRACT_FIELDS,
  ASSIGNABLE_PERSON_FIELDS,
  PERMISSIONS,
  PersonSourceDisabledError,
  PersonSourceOwnsPersonsError,
  UnassignableFieldError,
  applyImportRun,
  applyPersonSourceSchedule,
  createPersonSource,
  deletePersonSource,
  findPersonSource,
  listImportRuns,
  listPersonSources,
  localMasterKeyProvider,
  personMappingsFor,
  personSourceOwnedCount,
  personSourceWithCredential,
  queueImportRun,
  recordEvent,
  removePersonSourceSchedule,
  setPersonMappings,
  skipImportChange,
  updatePersonSource,
  type SchedulablePersonSource,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { confirmQuery, sourceIdQuery } from './list-query.js';

export interface PersonSourceRouteOptions {
  masterKey: Buffer;
  /** Late-bound, for the reason `SourceRouteOptions` records. */
  scheduler?: () => Scheduler | null;
}

export async function registerAdminPersonSourceRoutes(
  app: FastifyInstance,
  options: PersonSourceRouteOptions,
): Promise<void> {
  const provider = localMasterKeyProvider(options.masterKey);

  /**
   * Brings the scheduler into line with a source that just changed.
   *
   * A scheduling failure is logged, not raised: the mutation has already
   * committed by the time this runs, so a 500 here would report a failure for
   * work that succeeded and the caller would have no way to tell which half
   * happened.
   */
  const reschedule = async (
    request: FastifyRequest,
    source: SchedulablePersonSource,
  ): Promise<void> => {
    const scheduler = options.scheduler?.();
    if (!scheduler) return;
    try {
      await applyPersonSourceSchedule(scheduler, request.tenantId, source);
    } catch (cause) {
      request.log.error(
        { err: cause, sourceId: source.id },
        'the person source was saved but could not be scheduled',
      );
    }
  };

  /** Turns the service's refusals into problems a console can act on. */
  const asProblem = (cause: unknown): never => {
    if (cause instanceof UnknownPersonSourceTypeError) {
      throw new ProblemError(400, 'unknown-source-type', 'Unknown source type', cause.message);
    }
    if (cause instanceof UnassignableFieldError) {
      throw new ProblemError(
        400,
        'unassignable-field',
        'A mapping may not write that field',
        cause.message,
        { errors: cause.fields.map((path) => ({ path, message: 'not writable by a source' })) },
      );
    }
    if (cause instanceof PersonSourceDisabledError) {
      throw new ProblemError(409, 'source-disabled', 'This source is disabled', cause.message);
    }
    if (cause instanceof PersonSourceOwnsPersonsError) {
      throw new ProblemError(
        409,
        'source-owns-people',
        'This source still owns people',
        cause.message,
        { persons: cause.persons },
      );
    }
    if (cause instanceof ZodError) {
      throw new ProblemError(400, 'bad-request', 'Bad Request', undefined, {
        errors: cause.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw cause;
  };

  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/person-sources',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => ({ sources: await request.db((tx) => listPersonSources(tx)) }),
  );

  /**
   * What the mapping editor is allowed to write.
   *
   * Served rather than duplicated in the browser bundle so there is exactly
   * one definition: a target field the console offered but `setPersonMappings`
   * rejects is a 400 an administrator cannot act on.
   *
   * Static path, registered before `/person-sources/:id`.
   */
  app.get(
    '/person-sources/mapping-defaults',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async () => ({
      assignableFields: {
        person: ASSIGNABLE_PERSON_FIELDS,
        contract: ASSIGNABLE_CONTRACT_FIELDS,
      },
    }),
  );

  app.get(
    '/person-sources/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const source = await findPersonSource(tx, id);
        if (!source) throw new ProblemError(404, 'not-found', 'Person source not found');
        // Counted here rather than left for the delete to discover: the
        // console has to say how many people a deletion would deactivate
        // before it offers the button.
        return { ...source, owned: { persons: await personSourceOwnedCount(tx, id) } };
      });
    },
  );

  app.post(
    '/person-sources',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const body = createPersonSourceRequest.parse(request.body);
      const source = await request
        .db((tx) => createPersonSource(tx, provider, body))
        .catch(asProblem);
      await reschedule(request, source);
      return reply.code(201).send(source);
    },
  );

  app.patch(
    '/person-sources/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = updatePersonSourceRequest.parse(request.body);
      const source = await request
        .db((tx) => updatePersonSource(tx, provider, id, body))
        .catch(asProblem);
      if (!source) throw new ProblemError(404, 'not-found', 'Person source not found');
      await reschedule(request, source);
      return source;
    },
  );

  app.delete(
    '/person-sources/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { confirm } = confirmQuery.parse(request.query ?? {});
      const released = await request
        .db((tx) => deletePersonSource(tx, id, { confirm: confirm === 'true' }))
        .catch(asProblem);
      if (released === null) {
        throw new ProblemError(404, 'not-found', 'Person source not found');
      }
      const scheduler = options.scheduler?.();
      if (scheduler) await removePersonSourceSchedule(scheduler, request.tenantId, id);
      return released;
    },
  );

  /**
   * Tests the SAVED source, and reports what the server presented.
   *
   * The configuration is read from the row rather than taken from the request,
   * which is the difference between this and `/sources/test`. That endpoint
   * accepts a candidate configuration and therefore has to refuse one whose
   * transport contradicts the saved source, or a caller holding `sync.manage`
   * could point it at a socket they control and read the stored credential
   * back out of the vault. Nothing here is caller-supplied, so that path does
   * not exist: testing a different destination means saving it first.
   *
   * The connector call is made OUTSIDE `request.db`. `withTenant` is a
   * transaction on a short budget, and an SFTP connection to a host that is
   * not answering will sit there far longer -- an open transaction waiting on
   * a third party is how a connection pool is exhausted by one slow server.
   */
  app.post(
    '/person-sources/:id/test',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const prepared = await request.db(async (tx) => {
        const source = await findPersonSource(tx, id);
        if (!source) throw new ProblemError(404, 'not-found', 'Person source not found');
        const config = await personSourceWithCredential(tx, provider, id);
        if (!config) {
          throw new ProblemError(409, 'credential-missing', 'This source has no credential');
        }
        return { type: source.type, config };
      });

      const result = await personSourceConnectorFor(prepared.type).test(
        prepared.config as never,
      );

      // Recorded whether or not it matched. A key somebody saw is a fact worth
      // being able to find later, and a mismatch is the one an incident asks
      // about.
      if (result.hostKey !== undefined) {
        const hostKey = result.hostKey;
        await request.db((tx) =>
          recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'person_source.host_key_seen',
            targetType: 'PersonSource',
            targetId: id,
            outcome: 'success',
            sourceIp: request.ip ?? null,
            payload: { fingerprint: hostKey.fingerprint, status: hostKey.status },
          }),
        );
      }
      return result;
    },
  );

  /**
   * Accepting the host key the test just showed.
   *
   * Two endpoints rather than one, deliberately: `test` reports what the
   * server presented, this accepts it. Folding them together would be a test
   * that pins a key as a side effect, which is trust-on-first-use wearing a
   * diagnostic's clothing.
   *
   * The fingerprint is echoed back and compared, so an administrator confirms
   * the key they were shown rather than whatever answers when the request
   * lands. Re-pinning a DIFFERENT key is refused here: a changed key is a
   * rebuilt server or an interception, and clearing the pin is a deliberate
   * edit of the source rather than a confirmation dialog.
   */
  app.post(
    '/person-sources/:id/host-key',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { fingerprint } = acceptHostKeyRequest.parse(request.body);

      return request.db(async (tx) => {
        const source = await findPersonSource(tx, id);
        if (!source) throw new ProblemError(404, 'not-found', 'Person source not found');

        const config = source.config as Record<string, unknown>;
        const pinned = config.hostKeyFingerprint;
        if (typeof pinned === 'string' && pinned !== '' && pinned !== fingerprint) {
          throw new ProblemError(
            409,
            'host-key-mismatch',
            'This source is pinned to a different host key',
            `it is pinned to ${pinned}; a server presenting ${fingerprint} is ` +
              `either rebuilt or being impersonated, and changing the pin is an ` +
              `edit of the source rather than a confirmation`,
          );
        }

        const updated = await updatePersonSource(tx, provider, id, {
          config: { ...config, hostKeyFingerprint: fingerprint },
        }).catch(asProblem);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person_source.host_key_accepted',
          targetType: 'PersonSource',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip ?? null,
          payload: { fingerprint },
        });
        return updated;
      });
    },
  );

  app.get(
    '/person-sources/:id/mappings',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const source = await findPersonSource(tx, id);
        if (!source) throw new ProblemError(404, 'not-found', 'Person source not found');
        return { rules: await personMappingsFor(tx, id) };
      });
    },
  );

  app.put(
    '/person-sources/:id/mappings',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { mappings } = setPersonMappingsRequest.parse(request.body);
      const rules = await request
        .db(async (tx) => {
          const source = await findPersonSource(tx, id);
          if (!source) throw new ProblemError(404, 'not-found', 'Person source not found');
          return setPersonMappings(tx, id, mappings);
        })
        .catch(asProblem);
      return { rules };
    },
  );

  app.post(
    '/person-sources/:id/run',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const scheduler = options.scheduler?.();
      if (!scheduler) {
        throw new ProblemError(
          503,
          'scheduler-unavailable',
          'The job queue is not running',
          'a run is a background job, and the queue this installation uses is not up',
        );
      }
      const run = await queueImportRun(scheduler, request.tenantId, id).catch(asProblem);
      return reply.code(202).send(run);
    },
  );

  app.get(
    '/person-import-runs',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { sourceId } = sourceIdQuery.parse(request.query ?? {});
      return { runs: await request.db((tx) => listImportRuns(tx, sourceId)) };
    },
  );

  app.get(
    '/person-import-runs/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const run = await tx.personImportRun.findUnique({ where: { id } });
        if (!run) throw new ProblemError(404, 'not-found', 'Import run not found');
        const changes = await tx.personImportChange.findMany({
          where: { runId: id },
          orderBy: { changeType: 'asc' },
        });
        // The denominator the guard measured, so the confirming administrator
        // reads the same number the refusal was computed from.
        const owned = await personSourceOwnedCount(tx, run.sourceId);
        return { run, changes, denominators: { activePersonsFromSource: owned } };
      });
    },
  );

  app.post(
    '/person-import-runs/:id/apply',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = applyImportRunRequest.parse(request.body ?? {});
      try {
        return await applyImportRun(request.tenantId, id, {
          ...(body.only === undefined ? {} : { only: body.only }),
          ...(body.confirm === undefined ? {} : { confirm: body.confirm }),
          confirmedBy: request.session.userId,
        });
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause;
        // The service refuses a blocked run by throwing. That is a conflict
        // the console can act on -- by confirming -- not a server error.
        if (cause.message.includes('blocked')) {
          throw new ProblemError(409, 'run-blocked', 'This run is blocked', cause.message);
        }
        // And a run id that names nothing is the caller's mistake, not this
        // server's. Left alone it answered 500, which tells an operator to go
        // and look at the logs for a request that was simply wrong.
        if (cause.message.startsWith('no such import run')) {
          throw new ProblemError(404, 'not-found', 'Import run not found');
        }
        throw cause;
      }
    },
  );

  app.post(
    '/person-import-runs/:runId/changes/:id/skip',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        // Checked rather than left to Prisma's update, whose "record not
        // found" surfaces as a 500 -- which sends an operator to the logs for
        // a request that was simply wrong.
        const change = await tx.personImportChange.findUnique({ where: { id } });
        if (!change) throw new ProblemError(404, 'not-found', 'Change not found');
        return skipImportChange(tx, id);
      });
    },
  );
}
