import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyRunRequest, idParam } from '@syntra/contracts';
import {
  PERMISSIONS,
  applyRun,
  listRuns,
  recordEvent,
  skipChange,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const listQuery = z.object({ sourceId: z.string().uuid().optional() });

export async function registerAdminSyncRunRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/sync-runs',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { sourceId } = listQuery.parse(request.query);
      return { runs: await request.db((tx) => listRuns(tx, sourceId)) };
    },
  );

  app.get(
    '/sync-runs/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const run = await tx.syncRun.findUnique({ where: { id } });
        if (!run) throw new ProblemError(404, 'not-found', 'Run not found');
        const changes = await tx.syncChange.findMany({
          where: { runId: id },
          orderBy: [{ changeType: 'asc' }, { id: 'asc' }],
        });
        return { ...run, changes };
      });
    },
  );

  app.post(
    '/sync-runs/:id/apply',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = applyRunRequest.parse(request.body ?? {});

      // Checked here, structurally, rather than by matching applyRun's error
      // message: a missing run is a 404, and it should not depend on string
      // matching to be told apart from a blocked one.
      const existing = await request.db((tx) =>
        tx.syncRun.findUnique({ where: { id } }),
      );
      if (!existing) throw new ProblemError(404, 'not-found', 'Run not found');

      // applyRun takes a tenantId, not a caller's transaction: it opens a
      // fresh transaction per change, since PostgreSQL aborts a transaction
      // on the first error and a shared transaction could not then mark that
      // change failed and continue with the rest.
      let run;
      try {
        run = await applyRun(request.tenantId, id, {
          ...(body.only ? { only: body.only } : {}),
          ...(body.confirm ? { confirm: true } : {}),
        });
      } catch (cause) {
        if (cause instanceof Error && /blocked/i.test(cause.message)) {
          throw new ProblemError(
            409,
            'run-blocked',
            'Run blocked',
            cause.message,
          );
        }
        throw cause;
      }

      await request.db(async (tx) => {
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'sync.apply',
          targetType: 'SyncRun',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          // Whether a threshold-blocked run was waved through is exactly the
          // kind of decision the log exists to hold.
          payload: { status: run.status, confirmed: body.confirm === true },
        });
      });

      return run;
    },
  );

  app.post(
    '/sync-changes/:id/skip',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      // The skip and its audit event in one transaction, as every other
      // admin mutation on this branch does: a change to what a run says it
      // did, with no record of who changed it, is the hole the hash chain
      // exists to close.
      await request.db(async (tx) => {
        const change = await tx.syncChange.findUnique({ where: { id } });
        if (!change) {
          throw new ProblemError(404, 'not-found', 'Change not found');
        }
        if (change.status !== 'proposed') {
          throw new ProblemError(
            409,
            'change-not-proposed',
            'Change is not proposed',
            `this change is already ${change.status}; only a proposed change ` +
              `can be skipped, so that a run's record of what it did stays true`,
          );
        }

        await skipChange(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'sync.skip_change',
          targetType: 'SyncChange',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { runId: change.runId, changeType: change.changeType },
        });
      });

      return reply.status(204).send();
    },
  );
}
