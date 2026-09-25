import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acknowledgeDriftRequestSchema,
  applyRunRequestSchema,
  cancelRunRequest,
  idParam,
} from '@syntra/contracts';
import {
  DriftFindingNotFoundError,
  PERMISSIONS,
  PROVISION_JOB,
  ProvisionRunNotAppliableError,
  ProvisionRunNotConfirmableError,
  MaintenanceWindowClosedError,
  ExternalWritesPausedError,
  AdapterVersionChangedError,
  AdapterWritesBlockedError,
  RunNotCancellableError,
  RunNotFoundError,
  acknowledgeDriftFinding,
  requestCancelProvisionRun,
  applyProvisionRun,
  enqueuePairedSync,
  type MasterKeyProvider,
  provisionJobPayload,
  type Scheduler,
  type Transport,
  type DriftKind,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface ProvisionRunRouteOptions {
  keyProvider: MasterKeyProvider;
  scheduler?: () => Scheduler | null;
  /** The app's mail transport, so a created account's pickup link can be delivered. */
  transport: Transport;
  /** PUBLIC_URL, which that pickup link is built on. */
  publicUrl: string;
}

/**
 * A target id and a run id, both parsed.
 *
 * `idParam.extend` rather than a second `z.object({ id: … })`: the shape of a
 * target id is defined in one place, and a route that names two ids must not
 * be the place a looser one creeps in. `@syntra/contracts` carries no
 * two-id schema for this pair yet; when it does, this is the thing to delete.
 */
export const runParams = idParam.extend({ runId: z.string().uuid() });

/** How many runs, actions and findings one request may return. */
const RUN_PAGE = 50;
const DRIFT_PAGE = 500;

/**
 * The drift list's filters. Parsed, not cast: cast, a repeated `?status=`
 * reached Prisma as an array and answered 500 for a caller's mistake. The
 * kinds are checked against core's `DriftKind`; the statuses are the three
 * the schema documents on `DriftFinding.status`.
 */
export const driftListQuery = z
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
  const provider = options.keyProvider;

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
      //
      // `requested`: a plan left `previewed` on the target is superseded by
      // this one rather than making it skip. A run held for confirmation is
      // not -- the job skips and says so on the target, as the schedule does.
      const jobId = await scheduler.enqueue(
        PROVISION_JOB,
        provisionJobPayload(request.tenantId, id, { requested: true }),
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
          ...(body.maintenanceOverrideReason === undefined
            ? {}
            : { maintenanceOverrideReason: body.maintenanceOverrideReason }),
          transport: options.transport,
          publicUrl: options.publicUrl,
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
        if (cause instanceof MaintenanceWindowClosedError) {
          throw new ProblemError(
            409,
            'maintenance-window-closed',
            'Target maintenance window is closed',
            cause.message,
            { overrideAllowed: cause.overrideAllowed },
          );
        }
        // An emergency stop, tenant-wide or on this target. The run is left
        // as previewed, so it can be applied unchanged once writes resume.
        if (cause instanceof ExternalWritesPausedError) {
          throw new ProblemError(
            409,
            'external-writes-paused',
            'External writes are paused',
            cause.message,
            { scope: cause.scope },
          );
        }
        // The adapter gates. Nothing was attempted and the run is left as it
        // was previewed; the detail says what to do instead.
        if (cause instanceof AdapterWritesBlockedError) {
          throw new ProblemError(409, 'adapter-writes-blocked', 'The adapter may not write', cause.message);
        }
        if (cause instanceof AdapterVersionChangedError) {
          throw new ProblemError(409, 'adapter-version-changed', 'The plan is for a different adapter release', cause.message, {
            plannedVersion: cause.plannedVersion,
            currentVersion: cause.currentVersion,
          });
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

  /**
   * Asks a provisioning run to stop, under PROVISION_MANAGE — the permission
   * that starts and applies one.
   *
   * A `previewed` or `blocked` plan is cancelled on the spot and its actions
   * abandoned (and any revocation order they carried re-opened for the next
   * run). A preview still reading the target, or an apply writing to it, is
   * asked, and stops at its next checkpoint: an apply between two actions,
   * never between an action's `in_flight` marker and the target's answer.
   */
  app.post(
    '/targets/:id/runs/:runId/cancel',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id, runId } = runParams.parse(request.params);
      cancelRunRequest.parse(request.body ?? {});
      try {
        return await request.db(async (tx) => {
          // Named through this target or not at all, as every run route here.
          const existing = await tx.provisionRun.findUnique({
            where: { id: runId },
            select: { targetSystemId: true },
          });
          if (!existing || existing.targetSystemId !== id) throw new RunNotFoundError(runId);
          const result = await requestCancelProvisionRun(tx, runId, {
            userId: request.session.userId,
            sourceIp: request.ip,
          });
          const run = await tx.provisionRun.findUniqueOrThrow({ where: { id: runId } });
          return { ...result, run };
        });
      } catch (cause) {
        if (cause instanceof RunNotFoundError) {
          throw new ProblemError(404, 'not-found', 'Run not found');
        }
        if (cause instanceof RunNotCancellableError) {
          throw new ProblemError(409, 'run-not-cancellable', 'This run has already finished', cause.message);
        }
        throw cause;
      }
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
