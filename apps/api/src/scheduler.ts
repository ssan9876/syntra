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
 * Schedules every enabled directory source that has a cron expression,
 * across every tenant, on an already-started `Scheduler`.
 *
 * This runs once at process startup, not inside a request, so there is no
 * ambient tenant to scope the lookup to. It reads `Tenant` directly -- the
 * one model deliberately left outside row-level security, precisely so
 * startup code like this can enumerate tenants -- and then reads each
 * tenant's sources through `withTenant`, same as any other tenant-scoped
 * read.
 *
 * Nothing in here may reject. The tenant listing itself can fail (a
 * transient database hiccup at boot is enough), and so can the per-tenant
 * source lookup or an individual `schedule()` call (a malformed cron
 * expression). Every one of those is logged and treated as "schedule
 * nothing for this piece" rather than allowed to propagate -- an API that
 * comes up with sync unscheduled is strictly better than one that does not
 * come up at all.
 *
 * Takes the `Scheduler` rather than constructing one, so it can be
 * exercised directly against a fake in tests without standing up pg-boss.
 */
export async function scheduleAllSyncSources(
  scheduler: Scheduler,
  logger: FastifyBaseLogger,
): Promise<void> {
  let tenants;
  try {
    tenants = await prisma.tenant.findMany();
  } catch (cause) {
    logger.error(
      { err: cause },
      'failed to list tenants for scheduling; no directory sources were scheduled',
    );
    return;
  }

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
}

/**
 * Starts the background job scheduler and schedules every enabled,
 * cron-bearing directory source across every tenant. See
 * `scheduleAllSyncSources` for the scheduling behaviour and its failure
 * handling.
 */
export async function startSyncScheduler(
  config: Config,
  logger: FastifyBaseLogger,
): Promise<Scheduler> {
  const scheduler = createScheduler(config.databaseUrl);
  const provider = localMasterKeyProvider(config.masterKey);
  registerSyncJobs(scheduler, provider);
  await scheduler.start();

  await scheduleAllSyncSources(scheduler, logger);

  return scheduler;
}
