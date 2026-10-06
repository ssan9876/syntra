import type { FastifyInstance } from 'fastify';
import {
  PERMISSIONS,
  activeRestoreHold,
  hasPermission,
  recordEvent,
  releaseRestoreHolds,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

/**
 * A restore that has not been resumed.
 *
 * Every administrator can see one: it pauses work in every tenant, and a
 * tenant administrator whose scheduled runs stopped needs to know why. Only a
 * `deployment.manage` holder can resume, the same permission that restarts
 * the installation for an update.
 */
export async function registerAdminRestoreHoldRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get('/restore-hold', async (request) => {
    const hold = await activeRestoreHold();
    const mayResume = hold
      ? await request.db((tx) =>
          hasPermission(tx, request.session.userId, PERMISSIONS.DEPLOYMENT_MANAGE),
        )
      : false;
    return {
      hold: hold && {
        backupName: hold.backupName,
        backupTakenAt: hold.backupTakenAt?.toISOString() ?? null,
        backupVersion: hold.backupVersion,
        restoredAt: hold.restoredAt.toISOString(),
      },
      mayResume,
    };
  });

  app.post(
    '/restore-hold/resume',
    { preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE) },
    async (request) => {
      const hold = await activeRestoreHold();
      if (!hold) {
        throw new ProblemError(409, 'not-held', 'Already resumed', 'No restore is waiting to be resumed.');
      }
      await releaseRestoreHolds();
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'deployment.restore_resumed',
          targetType: 'Deployment',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            backupName: hold.backupName,
            backupTakenAt: hold.backupTakenAt?.toISOString() ?? null,
            restoredAt: hold.restoredAt.toISOString(),
          },
        }),
      );
      return { resumed: true };
    },
  );
}
