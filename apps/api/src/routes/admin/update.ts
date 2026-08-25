import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  checkForUpdate,
  isNewer,
  launchUpdater,
  readProgress,
  recordEvent,
  type UpdateEnvironment,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface UpdateRouteOptions {
  releaseRepo: string | null;
  releaseToken: string | null;
  releaseRoot: string;
  /** Built from the port this process actually bound. See launchUpdater. */
  readyUrl: string;
}

const startRequest = z.object({
  /** Named explicitly, so a race with a newer release cannot install a
   *  version the operator never saw the notes for. */
  version: z.string().trim().min(1).max(64),
});

/**
 * Updating the deployment from the console.
 *
 * Every route here is behind `deployment.manage` rather than `tenant.manage`.
 * The distinction is not bureaucratic: this restarts the installation, migrates
 * the database and signs everybody out for a minute, and in a shared
 * deployment that is not one customer's administrator's decision to make.
 */
export async function registerAdminUpdateRoutes(
  app: FastifyInstance,
  options: UpdateRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  const env = (): UpdateEnvironment => ({
    repo: options.releaseRepo ?? '',
    token: options.releaseToken,
    root: options.releaseRoot,
    readyUrl: options.readyUrl,
  });

  const configured = (): boolean =>
    options.releaseRepo !== null && options.releaseToken !== null;

  app.get(
    '/update',
    { preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE) },
    async () => {
      const availability = await checkForUpdate(env());
      return {
        ...availability,
        // Read from disk rather than remembered: the process that started the
        // last update was restarted by it.
        progress: readProgress(options.releaseRoot),
      };
    },
  );

  app.get(
    '/update/status',
    { preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE) },
    async () => ({ progress: readProgress(options.releaseRoot) }),
  );

  app.post(
    '/update',
    { preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE) },
    async (request, reply) => {
      const { version } = startRequest.parse(request.body);

      if (!configured()) {
        throw new ProblemError(
          409,
          'updates-not-configured',
          'Updates are not configured',
          'This deployment has no release repository or token configured, so it ' +
            'cannot look for or install new versions.',
        );
      }

      const availability = await checkForUpdate(env());
      if (!availability.updatable) {
        // 422 rather than 409: the request is well formed and the caller is
        // entitled to make it; this install simply is not a thing that can be
        // updated from here.
        throw new ProblemError(
          422,
          'not-updatable',
          'This install cannot be updated from the console',
          availability.reason ?? 'This install cannot be updated from the console.',
        );
      }

      if (!isNewer(version, availability.current)) {
        throw new ProblemError(
          422,
          'not-newer',
          'That version is not newer',
          `This deployment is running ${availability.current}, and ${version} is ` +
            'not newer than it. Downgrading is not something this button does.',
        );
      }

      const progress = readProgress(options.releaseRoot);
      if (progress?.running) {
        throw new ProblemError(
          409,
          'update-in-progress',
          'An update is already running',
          `An update is already at the "${progress.step}" step. Wait for it to finish.`,
        );
      }

      // Audited BEFORE it starts, and deliberately: the restart this causes
      // may well kill this process before any later write could land, and an
      // update with no record of who asked for it is the one nobody can
      // account for afterwards.
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'deployment.update_requested',
          targetType: 'Deployment',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { from: availability.current, to: version },
        }),
      );

      const launched = launchUpdater(env(), version);
      if (!launched.ok) {
        throw new ProblemError(
          500,
          'update-not-started',
          'The updater could not be started',
          launched.reason,
        );
      }

      // 202: it has been accepted and is happening elsewhere. A 200 would
      // imply this response came back after the work, and the work outlives
      // the process answering.
      return reply.status(202).send({
        started: true,
        from: availability.current,
        to: version,
      });
    },
  );

  app.post(
    '/update/rollback',
    { preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE) },
    async (request, reply) => {
      if (!configured()) {
        throw new ProblemError(
          409,
          'updates-not-configured',
          'Updates are not configured',
          'This deployment has no release configuration, so it has no release ' +
            'history to roll back through.',
        );
      }

      const progress = readProgress(options.releaseRoot);
      if (progress?.running) {
        throw new ProblemError(
          409,
          'update-in-progress',
          'An update is already running',
          `An update is at the "${progress.step}" step. Wait for it to finish.`,
        );
      }

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'deployment.rollback_requested',
          targetType: 'Deployment',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {},
        }),
      );

      const launched = launchUpdater(env(), '--rollback');
      if (!launched.ok) {
        throw new ProblemError(
          500,
          'rollback-not-started',
          'The rollback could not be started',
          launched.reason,
        );
      }
      return reply.status(202).send({ started: true });
    },
  );
}
