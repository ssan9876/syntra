import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  createSourceRequest,
  deleteSourceQuery,
  idParam,
  setMappingsRequest,
  testConnectionRequest,
  updateSourceRequest,
} from '@syntra/contracts';
import {
  ldapConfigSchema,
  ldapConnector,
  type SchemaDescriptor,
} from '@syntra/connectors';
import {
  ASSIGNABLE_FIELDS,
  DEFAULT_MAPPINGS,
  PERMISSIONS,
  SourceCountsChangedError,
  SourceOwnsObjectsError,
  applySourceSchedule,
  createSource,
  deleteSource,
  findSource,
  listSources,
  localMasterKeyProvider,
  mappingsFor,
  ownedObjectCounts,
  queueRun,
  SourceDisabledError,
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
import { confirmQuery } from './list-query.js';

/**
 * The contract's acknowledgement counts, with the same `confirm` every other
 * destructive route reads. `merge` takes the strictness of its argument, so an
 * unknown key is refused here as it is there.
 */
const deleteQuery = deleteSourceQuery.omit({ confirm: true }).merge(confirmQuery);

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

  /**
   * What the mapping editor starts from, and what it is allowed to write.
   *
   * Served rather than duplicated in the browser bundle so there is exactly
   * one definition of both: a default the console disagreed with would seed a
   * mapping the server then refuses, and a target field the console offered
   * but `setMappings` rejects is a 400 an administrator cannot act on.
   *
   * Static path, and registered before `/sources/:id` — find-my-way prefers a
   * static segment over a parametric one regardless of order, but the reading
   * order should not depend on knowing that.
   */
  app.get(
    '/sources/mapping-defaults',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async () => ({
      flavours: DEFAULT_MAPPINGS,
      assignableFields: ASSIGNABLE_FIELDS,
    }),
  );

  app.get(
    '/sources/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      return request.db(async (tx) => {
        const source = await findSource(tx, id);
        if (!source) throw new ProblemError(404, 'not-found', 'Source not found');

        // Counted here rather than left for the delete to discover, because
        // the console has to say how many accounts a deletion would
        // deactivate *before* it offers the button. `DELETE` refuses without
        // `?confirm=true` and returns the same numbers on the 409, but a
        // refusal an administrator has to trigger to read is a worse way to
        // learn the size of what they are about to do.
        return { ...source, owned: await ownedObjectCounts(tx, id) };
      });
    },
  );

  app.get(
    '/sources/:id/mappings',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      return request.db(async (tx) => {
        const source = await findSource(tx, id);
        if (!source) throw new ProblemError(404, 'not-found', 'Source not found');
        return { rules: await mappingsFor(tx, id) };
      });
    },
  );

  /**
   * Tests a connection that has not been saved, and reports what it found.
   *
   * Spec section 11 asks for the test to happen *before* anything is written,
   * and success criterion 1 asks the product to "report what object classes
   * and attributes it found" — so this answers the counts from `test()` and
   * the descriptor from `discoverSchema()`, which until now had no caller
   * outside its own test.
   *
   * Both calls are made **outside** `request.db`. `withTenant` is
   * `prisma.$transaction(fn)` on a five-second budget, and an LDAP connection
   * to a host that is not answering will sit there far longer than that: an
   * open transaction waiting on a third party is how a connection pool is
   * exhausted by one slow directory. The vault read is its own short
   * transaction, closed before the socket is opened.
   *
   * A failed connection is a result, not a server error. A malformed
   * configuration is the caller's mistake and comes back as a 400 from
   * `ldapConfigSchema` with the offending field named, which is what lets the
   * editor mark the field rather than shrug.
   *
   * ## Borrowing the stored credential does not mean borrowing it for anywhere
   *
   * A request naming `sourceId` without a password is asking Syntra to fetch
   * the bind password out of the vault and send it somewhere. Where, is the
   * whole question. Splicing the vault entry into the caller's configuration
   * verbatim would let anyone holding `sync.manage` read the credential back
   * out of the vault by pointing `url` at a socket they control — in cleartext
   * with `tlsMode: "plain"` — in one request that changes nothing and would
   * therefore leave nothing behind to notice.
   *
   * So the transport is taken from the **saved source**, not from the request,
   * and a request that contradicts it is refused rather than quietly
   * corrected: silently testing an address other than the one on screen is its
   * own kind of lie. Testing a different destination is still allowed — it
   * just costs the password, which is exactly the proof of possession that was
   * missing.
   */
  app.post(
    '/sources/test',
    // SYNC_MANAGE, not SYNC_READ: this opens a connection to any host the
    // caller names, which is a capability worth restricting to the people who
    // are allowed to configure sources anyway.
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const body = testConnectionRequest.parse(request.body);

      // Parsed here rather than left to the connector, because the guard below
      // has to compare resolved values: `tlsMode` left out is derived from the
      // URL scheme, and `rejectUnauthorized` left out is true.
      const requested = ldapConfigSchema.parse(body.config);

      /** Recorded whatever happens, including when the request is refused. */
      const audit = async (
        outcome: 'success' | 'failure',
        detail: Record<string, unknown>,
      ) => {
        await request.db((tx) =>
          recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'source.test',
            targetType: 'DirectorySource',
            targetId: body.sourceId ?? null,
            outcome,
            sourceIp: request.ip,
            // Where a connection was attempted and how it was protected. The
            // bind DN is left out as the rest of this file leaves it out, and
            // the password never appears anywhere near here.
            payload: {
              url: requested.url,
              tlsMode: requested.tlsMode,
              rejectUnauthorized: requested.rejectUnauthorized,
              usedStoredCredential: body.bindPassword === undefined,
              ...detail,
            },
          }),
        );
      };

      let bindPassword = body.bindPassword;
      if (bindPassword === undefined && body.sourceId !== undefined) {
        // An editor changing a search base must not have to re-type the
        // credential, and the browser is never handed it to send back. So the
        // saved source's vault entry stands in, named by id.
        const saved = await request.db((tx) =>
          sourceWithPassword(tx, provider, body.sourceId!),
        );
        if (!saved) throw new ProblemError(404, 'not-found', 'Source not found');

        const changed = (
          [
            ['url', saved.url.trim(), requested.url.trim()],
            ['tlsMode', saved.tlsMode, requested.tlsMode],
            [
              'rejectUnauthorized',
              String(saved.rejectUnauthorized),
              String(requested.rejectUnauthorized),
            ],
          ] as const
        ).find(([, was, now]) => was !== now);

        if (changed) {
          await audit('failure', { refused: 'transport-changed', field: changed[0] });
          throw new ProblemError(
            400,
            'transport-changed',
            'Retype the bind password to test this',
            `this request would send the stored bind password somewhere other ` +
              `than where it is saved (${changed[0]} is "${changed[2]}", not ` +
              `"${changed[1]}"); type the password to test a different ` +
              `destination`,
            {
              errors: [
                {
                  path: changed[0],
                  message:
                    'changing this means the stored password cannot be reused; type it again to test',
                },
              ],
            },
          );
        }

        bindPassword = saved.bindPassword;
      }
      if (bindPassword === undefined) {
        throw new ProblemError(
          400,
          'bad-request',
          'Bad Request',
          'no bind password was sent and no saved source was named',
        );
      }

      const config = { ...requested, bindPassword };
      const result = await ldapConnector.test(config);
      if (!result.ok) {
        await audit('failure', { reason: 'connection-failed' });
        return { ...result, schema: null };
      }

      // Only after a successful bind, and never fatal: the counts are the
      // answer to "can Syntra reach this directory", and failing the whole
      // test because a schema sample came back badly would answer a narrower
      // question than the one that was asked.
      let schema: SchemaDescriptor | null = null;
      try {
        schema = await ldapConnector.discoverSchema(config);
      } catch (cause) {
        request.log.warn(
          { err: cause },
          'the connection succeeded but the schema could not be sampled',
        );
      }

      await audit('success', {});
      return { ...result, schema };
    },
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
              // The same `errors[]` shape the validation handler produces for
              // a body rejected at the contract boundary, so an editor marks
              // the offending field the same way whichever check caught it.
              // Without this a rejected TLS mode is a paragraph at the top of
              // a form with fourteen fields in it.
              {
                errors: cause.issues.map((i) => ({
                  path: i.path.join('.'),
                  message: i.message,
                })),
              },
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
      const { confirm, ackUsers, ackGroups, ackOrgUnits } = deleteQuery.parse(
        request.query ?? {},
      );

      // All three or none: a partial acknowledgement would check some of the
      // numbers the caller was shown and quietly ignore the rest.
      const acknowledged =
        ackUsers !== undefined &&
        ackGroups !== undefined &&
        ackOrgUnits !== undefined
          ? { users: ackUsers, groups: ackGroups, orgUnits: ackOrgUnits }
          : undefined;

      await request.db(async (tx) => {
        let released;
        try {
          released = await deleteSource(tx, id, { confirm: confirm === 'true', acknowledged });
        } catch (cause) {
          if (cause instanceof SourceCountsChangedError) {
            // The same 409 shape as the unconfirmed case, because it is the
            // same conversation: here are the numbers, ask me again.
            throw new ProblemError(
              409,
              'source-counts-changed',
              'The numbers changed',
              cause.message,
              { owned: cause.counts },
            );
          }
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
      const result = await ldapConnector.test(config);

      // AUDITED, like `/sources/test` beside it. This route opens a connection
      // to a configured directory with the stored bind credential, and the
      // outcome is exactly the thing somebody looks for when a source starts
      // failing -- a run of refusals here is how a rotated bind password is
      // noticed. Its sibling recorded every attempt including the refused
      // ones; this one recorded nothing at all.
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'source.test',
          targetType: 'DirectorySource',
          targetId: id,
          outcome: result.ok ? 'success' : 'failure',
          sourceIp: request.ip,
          // The same fields the unsaved variant records, minus the ones it
          // only has because the caller typed them. The bind DN is left out as
          // the rest of this file leaves it out, and the password appears
          // nowhere near here.
          payload: {
            url: config.url,
            tlsMode: config.tlsMode,
            rejectUnauthorized: config.rejectUnauthorized,
            usedStoredCredential: true,
            message: result.message,
          },
        }),
      );

      return result;
    },
  );

  app.post(
    '/sources/:id/run',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const scheduler = options.scheduler?.();
      if (!scheduler) {
        // 503 rather than falling back to running it here. The same failure
        // that leaves this null means no scheduled sync is running for any
        // source in any tenant, and quietly doing the work inline would hide a
        // broken deployment behind a button that still appears to work.
        throw new ProblemError(
          503,
          'scheduler-unavailable',
          'Background jobs are not running',
          'A run is a background job, and the job scheduler did not start. No scheduled sync is running either. Check the API log for why pg-boss failed to start.',
        );
      }
      // ENQUEUED, not performed. A directory read is network-bound and has no
      // time limit of its own; performing it inside the request holds a
      // connection open for the length of it, which is the shape that outlasts
      // a proxy timeout — the browser is told it failed while the run carries
      // on, and the operator's next move is to press the button again.
      try {
        const run = await queueRun(scheduler, request.tenantId, id);
        return reply.status(202).send(run);
      } catch (cause) {
        if (cause instanceof SourceDisabledError) {
          throw new ProblemError(
            409,
            'source-disabled',
            'This source is switched off',
            'A run would never be picked up. Enable the source first.',
          );
        }
        throw cause;
      }
    },
  );
}
