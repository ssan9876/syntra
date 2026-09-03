import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acknowledgeDriftRequestSchema,
  applyRunRequestSchema,
  idParam,
} from '@syntra/contracts';
import {
  DriftFindingNotFoundError,
  PERMISSIONS,
  PROVISION_JOB,
  ProvisionRunNotAppliableError,
  ProvisionRunNotConfirmableError,
  acknowledgeDriftFinding,
  applyProvisionRun,
  enqueuePairedSync,
  localMasterKeyProvider,
  provisionJobPayload,
  type Scheduler,
  type Transport,
  type DriftKind,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface ProvisionRunRouteOptions {
  masterKey: Buffer;
  scheduler?: () => Scheduler | null;
  /** The app's mail transport, so a created account's password can be delivered. */
  transport: Transport;
}

/**
 * A target id and a run id, both parsed.
 *
 * `idParam.extend` rather than a second `z.object({ id: … })`: the shape of a
 * target id is defined in one place, and a route that names two ids must not
 * be the place a looser one creeps in. `@syntra/contracts` carries no
 * two-id schema for this pair yet; when it does, this is the thing to delete.
 */
const runParams = idParam.extend({ runId: z.string().uuid() });

/** How many runs, actions and findings one request may return. */
const RUN_PAGE = 50;
const DRIFT_PAGE = 500;

/**
 * The drift list's filters. Parsed, not cast: cast, a repeated `?status=`
 * reached Prisma as an array and answered 500 for a caller's mistake. The
 * kinds are checked against core's `DriftKind`; the statuses are the three
 * the schema documents on `DriftFinding.status`.
 */
const driftListQuery = z
  .object({
    status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
    kind: z
      .enum([
        'unmanaged_entitlement',
        'missing_grant',
        'orphan_account',
        'account_missing_at_target',
        'unexpected_status',
        'container_vanished',
      ] as const satisfies readonly DriftKind[])
      .optional(),
  })
  .strict();

export async function registerAdminProvisionRunRoutes(
  app: FastifyInstance,
  options: ProvisionRunRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);

  app.post(
    '/targets/:id/runs',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: { id: true } }),
      );
      // Checked before anything is enqueued. A job carrying a target id that
      // does not exist fails inside the worker, on a queue, where the caller
      // never sees it.
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');

      const scheduler = options.scheduler?.();
      if (!scheduler) {
        throw new ProblemError(
          503,
          'scheduler-unavailable',
          'Background jobs are not running',
          'the run could not be enqueued; the API is up but the job scheduler is not',
        );
      }
      // Enqueued rather than run in the request: a full target read outlasts a
      // proxy timeout, which is the shape Directory Sync's synchronous
      // `Run now` endpoint still has and this one deliberately does not.
      const jobId = await scheduler.enqueue(
        PROVISION_JOB,
        provisionJobPayload(request.tenantId, id),
      );
      return reply.code(202).send({ jobId });
    },
  );

  app.get(
    '/targets/:id/runs',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return {
        runs: await request.db((tx) =>
          tx.provisionRun.findMany({
            where: { targetSystemId: id },
            orderBy: { startedAt: 'desc' },
            take: RUN_PAGE,
          }),
        ),
      };
    },
  );

  app.get(
    '/targets/:id/runs/:runId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id, runId } = runParams.parse(request.params);
      return request.db(async (tx) => {
        const run = await tx.provisionRun.findUnique({
          where: { id: runId },
          include: {
            actions: {
              // The order the apply will use, and the order the reviewer needs
              // to see. `createdAt` is transaction start time and is identical
              // across every row of the plan.
              orderBy: { sequence: 'asc' },
            },
            exceptions: {
              include: {
                person: { select: { id: true, givenName: true, familyName: true } },
              },
            },
          },
        });
        // Named through this target or not at all: the run id alone would let
        // target A's URL return target B's run, and the same confusion in the
        // apply below would enqueue a paired sync against the wrong target
        // entirely.
        if (!run || run.targetSystemId !== id) {
          throw new ProblemError(404, 'not-found', 'Run not found');
        }

        /**
         * Persons attached by a second read, not by an `include`.
         *
         * `ProvisionAction` carries a bare `personId` column and has **no**
         * relation to `Person` — deliberately, since spec section 15 forbids
         * this slice adding a back-relation to an existing table. An
         * `include: { person: … }` here does not compile. Grouping by person
         * is still what an administrator actually reads — "what is about to
         * happen to Anna" is the question — so the names are looked up in one
         * statement and joined in memory.
         */
        const personIds = [
          ...new Set(
            run.actions
              .map((a) => a.personId)
              .filter((personId): personId is string => personId !== null),
          ),
        ];
        const persons =
          personIds.length === 0
            ? []
            : await tx.person.findMany({
                where: { id: { in: personIds } },
                select: { id: true, givenName: true, familyName: true },
              });
        const personById = new Map(persons.map((p) => [p.id, p]));

        return {
          ...run,
          actions: run.actions.map((action) => ({
            ...action,
            person:
              action.personId === null
                ? null
                : (personById.get(action.personId) ?? null),
          })),
        };
      });
    },
  );

  app.post(
    '/targets/:id/runs/:runId/apply',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id, runId } = runParams.parse(request.params);
      const body = applyRunRequestSchema.parse(request.body ?? {});

      const run = await request.db((tx) =>
        tx.provisionRun.findUnique({ where: { id: runId } }),
      );
      if (!run || run.targetSystemId !== id) {
        throw new ProblemError(404, 'not-found', 'Run not found');
      }

      if (run.status === 'blocked' && !run.requiresConfirmation) {
        // Two conditions block outright, with no confirmation available,
        // because there is nothing an administrator could usefully confirm: a
        // target that returned no accounts at all may simply be unreachable,
        // and a person population that collapsed may be a broken HR feed.
        // Checked here AND inside `applyProvisionRun`, which is the control
        // that actually holds — this is the message, not the gate.
        throw new ProblemError(
          409,
          'run-unconfirmable',
          'This run cannot be applied',
          `it was blocked for a reason that cannot be confirmed away: ${run.blockedReason ?? ''}`,
        );
      }
      if (run.status === 'blocked' && !body.confirm) {
        throw new ProblemError(
          409,
          'run-needs-confirmation',
          'This run needs confirmation',
          `send confirm: true to apply it — ${run.blockedReason ?? ''}`,
        );
      }

      let result;
      try {
        result = await applyProvisionRun(request.tenantId, provider, runId, {
          ...(body.only === undefined ? {} : { only: body.only }),
          // Both, together. `confirm` is the deliberate act and
          // `confirmedByUserId` is who performed it; the apply requires both,
          // so a caller cannot satisfy the gate by passing a null user.
          ...(body.confirm
            ? { confirm: true, confirmedByUserId: request.session.userId }
            : {}),
          transport: options.transport,
        });
      } catch (cause) {
        // The same two refusals, reached by the race the pre-checks above
        // cannot close: a second apply between the read and the call. A 409
        // rather than a 500, because the state is the answer.
        if (cause instanceof ProvisionRunNotConfirmableError) {
          throw new ProblemError(
            409,
            'run-unconfirmable',
            'This run cannot be applied',
            cause.message,
          );
        }
        if (cause instanceof ProvisionRunNotAppliableError) {
          throw new ProblemError(
            409,
            'run-not-appliable',
            'This run cannot be applied',
            cause.message,
          );
        }
        throw cause;
      }

      // No `claimSyntraUsers` here any more. Claiming a login is maintenance
      // of a link and belongs at the start of a run — `runProvisionJob` does
      // it before the plan is computed — rather than after a write that may
      // never happen. Gated on `applied > 0` it never ran for the target that
      // needs it most, the converged one whose leaver was disabled by hand;
      // and after an apply it runs before the paired sync below has created
      // the user it would claim, so it could not have helped this run either.
      if (result.applied > 0) {
        const scheduler = options.scheduler?.();
        if (scheduler) await enqueuePairedSync(scheduler, request.tenantId, id);
      }
      return result;
    },
  );

  app.get(
    '/targets/:id/drift',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { status, kind } = driftListQuery.parse(request.query ?? {});
      return {
        findings: await request.db((tx) =>
          tx.driftFinding.findMany({
            where: {
              targetSystemId: id,
              ...(status === undefined ? {} : { status }),
              ...(kind === undefined ? {} : { kind }),
            },
            orderBy: { lastSeenAt: 'desc' },
            take: DRIFT_PAGE,
          }),
        ),
      };
    },
  );

  app.patch(
    // `:id` and not `:findingId`, so the id is parsed by the same `idParam`
    // every other admin route uses rather than by a second schema saying the
    // same thing. The path a caller sends is unchanged.
    '/drift/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id: findingId } = idParam.parse(request.params);
      const body = acknowledgeDriftRequestSchema.parse(request.body);
      // Through the audited core service, like every other write in this
      // package. This route used to write `driftFinding.updateMany` itself
      // with no audit entry at all — and acknowledging a finding is exactly
      // the action an auditor needs recorded: a human saying "this account
      // holds access Syntra never granted, and that is fine".
      try {
        await acknowledgeDriftFinding(
          request.tenantId,
          request.session.userId,
          findingId,
          body.status,
        );
      } catch (cause) {
        if (cause instanceof DriftFindingNotFoundError) {
          throw new ProblemError(404, 'not-found', 'Drift finding not found');
        }
        throw cause;
      }
      return reply.code(204).send();
    },
  );
}
