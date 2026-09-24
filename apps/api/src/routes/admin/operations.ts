import type { FastifyInstance } from 'fastify';
import { jobRepairBody } from '@syntra/contracts';
import {
  JobNotQueuedError,
  JobRepairRefusedError,
  PERMISSIONS,
  cachedComponentHealth,
  deploymentStatus,
  inspectJobHealth,
  repairJob,
  tenantStatus,
  type DeploymentStatus,
  type MasterKeyProvider,
  type Scheduler,
  type Transport,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * Operations: queue recovery (backlog #57) and status reporting (#63).
 *
 *   GET  /job-health          this tenant's orphaned, stuck, duplicated,
 *                             delayed, poisoned and saturation-deferred work
 *   POST /job-health/repair   one idempotent, audited repair
 *   GET  /status              this tenant's view: shared components and its
 *                             OWN degradation, nothing about other tenants
 *   GET  /deployment/status   the installation, for `deployment.manage`
 *
 * Reading is `audit.read`, as the Activity page's incidents are: everything
 * here is visible to somebody elsewhere already, and gating the summary
 * harder than its parts would hide it from the person who noticed. Repairing
 * is `tenant.manage`: a repair ends or restarts work across every subsystem,
 * which is authority over the whole tenant rather than one of its parts.
 */
export async function registerAdminOperationsRoutes(
  app: FastifyInstance,
  options: {
    keyProvider: MasterKeyProvider;
    transport?: Transport;
    scheduler?: () => Scheduler | null;
    webRoot?: string | undefined;
  },
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  const schedulerRunning = options.scheduler ? () => options.scheduler!() !== null : undefined;
  const components = cachedComponentHealth({
    provider: options.keyProvider,
    ...(schedulerRunning ? { schedulerRunning } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
  });

  // The operator view walks every tenant; fifteen seconds of cache keeps a
  // page left open from multiplying that.
  let deployment: { at: number; value: DeploymentStatus } | null = null;

  app.get(
    '/job-health',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => inspectJobHealth(request.tenantId),
  );

  app.post(
    '/job-health/repair',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const body = jobRepairBody.parse(request.body ?? {});
      try {
        const result = await repairJob(
          request.tenantId,
          {
            kind: body.kind,
            subjectId: body.subjectId,
            action: body.action,
            reason: body.reason,
            actorUserId: request.session.userId,
            sourceIp: request.ip,
          },
          { scheduler: options.scheduler?.() ?? null },
        );
        return { repair: result };
      } catch (cause) {
        if (cause instanceof JobRepairRefusedError) {
          throw new ProblemError(
            cause.code === 'scheduler-unavailable' ? 503 : 409,
            cause.code === 'scheduler-unavailable' ? 'scheduler-unavailable' : 'repair-not-allowed',
            'Repair refused',
            cause.message,
          );
        }
        if (cause instanceof JobNotQueuedError) {
          throw new ProblemError(503, 'job-not-queued', 'The job was not queued', `${cause.message}. Nothing was changed; try again once the job queue is healthy.`);
        }
        throw cause;
      }
    },
  );

  app.get(
    '/status',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => tenantStatus(request.tenantId, await components()),
  );

  app.get(
    '/deployment/status',
    { preHandler: requirePermission(PERMISSIONS.DEPLOYMENT_MANAGE) },
    async () => {
      if (deployment && Date.now() - deployment.at < 15_000) return deployment.value;
      const value = await deploymentStatus({
        provider: options.keyProvider,
        ...(schedulerRunning ? { schedulerRunning } : {}),
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.scheduler ? { scheduler: options.scheduler } : {}),
        webRoot: options.webRoot,
      });
      deployment = { at: Date.now(), value };
      return value;
    },
  );
}
