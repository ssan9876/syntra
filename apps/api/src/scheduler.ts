import type { FastifyBaseLogger } from 'fastify';
import { prisma, withTenant } from '@syntra/db';
import {
  createScheduler,
  localMasterKeyProvider,
  registerSyncJobs,
  syncJobPayload,
  SYNC_JOB,
  type Config,
  type Scheduler,
} from '@syntra/core';

/**
 * Starts the background job scheduler and schedules every enabled directory
 * source that has a cron expression, across every tenant.
 *
 * This runs once at process startup, not inside a request, so there is no
 * ambient tenant to scope the lookup to. It reads `Tenant` directly -- the
 * one model deliberately left outside row-level security, precisely so
 * startup code like this can enumerate tenants -- and then reads each
 * tenant's sources through `withTenant`, same as any other tenant-scoped
 * read.
 *
 * A source that fails to schedule (a malformed cron expression, a database
 * hiccup) must not prevent the API from starting, and must not stop the
 * remaining sources from being scheduled: each failure is logged and the
 * loop continues.
 */
export async function startSyncScheduler(
  config: Config,
  logger: FastifyBaseLogger,
): Promise<Scheduler> {
  const scheduler = createScheduler(config.databaseUrl);
  const provider = localMasterKeyProvider(config.masterKey);
  registerSyncJobs(scheduler, provider);
  await scheduler.start();

  const tenants = await prisma.tenant.findMany();

  for (const tenant of tenants) {
    let sources;
    try {
      sources = await withTenant(tenant.id, (tx) =>
        tx.directorySource.findMany({
          where: { enabled: true, schedule: { not: null } },
        }),
      );
    } catch (cause) {
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to load directory sources for scheduling',
      );
      continue;
    }

    for (const source of sources) {
      try {
        await scheduler.schedule(
          SYNC_JOB,
          source.schedule!,
          syncJobPayload(tenant.id, source.id),
        );
      } catch (cause) {
        logger.error(
          { err: cause, tenantId: tenant.id, sourceId: source.id },
          'failed to schedule directory sync source',
        );
      }
    }
  }

  return scheduler;
}
