import type { FastifyBaseLogger } from 'fastify';
import { prisma, withTenant } from '@syntra/db';
import {
  applySourceSchedule,
  createScheduler,
  localMasterKeyProvider,
  registerKeyRotationJob,
  registerSyncJobs,
  scheduleKeyRotation,
  type Config,
  type Scheduler,
} from '@syntra/core';

/**
 * Reconciles the scheduler against every tenant: one signing-key rotation
 * apiece, and every directory source, with enabled cron-bearing sources
 * scheduled and the rest unscheduled.
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
export async function scheduleBackgroundWork(
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
    try {
      // Spec section 12: signing keys rotated on a schedule, with overlap.
      // Idempotent -- pg-boss keys the schedule row on (queue, key) and this
      // one names the tenant and the kind -- so re-running it at every boot
      // reconciles rather than accumulates.
      await scheduleKeyRotation(scheduler, tenant.id);
    } catch (cause) {
      logger.error(
        { err: cause, tenantId: tenant.id },
        'failed to schedule signing key rotation',
      );
    }
  }

  for (const tenant of tenants) {
    let sources;
    try {
      // Every source, not only the eligible ones. pg-boss keeps its schedules
      // in the database, so a source disabled or unscheduled while this
      // process was down still has a schedule row waiting for it; reading the
      // whole list lets `applySourceSchedule` remove those as well as add the
      // rest, which is the difference between reconciling and appending.
      sources = await withTenant(tenant.id, (tx) =>
        tx.directorySource.findMany(),
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
        await applySourceSchedule(scheduler, tenant.id, source);
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
 * `scheduleBackgroundWork` for the scheduling behaviour and its failure
 * handling.
 *
 * This never rejects, which is what `server.ts` relies on when it says a
 * scheduling failure must not keep the API from coming up. `scheduler.start()`
 * talks to PostgreSQL and creates pg-boss's queues, and it can fail for
 * reasons that have nothing to do with whether people can sign in; when it
 * does, that is logged and `null` is returned. An API serving sessions with
 * sync unscheduled is strictly better than one that does not boot.
 *
 * Takes its scheduler factory as a parameter for the same reason
 * `scheduleBackgroundWork` takes a `Scheduler`: so the failure path can be
 * exercised without standing up pg-boss.
 */
export async function startSyncScheduler(
  config: Config,
  logger: FastifyBaseLogger,
  create: (databaseUrl: string) => Scheduler = createScheduler,
): Promise<Scheduler | null> {
  let scheduler: Scheduler;
  try {
    scheduler = create(config.databaseUrl);
    const provider = localMasterKeyProvider(config.masterKey);
    registerSyncJobs(scheduler, provider);
    registerKeyRotationJob(scheduler, provider);
    await scheduler.start();
  } catch (cause) {
    logger.error(
      { err: cause },
      'the background job scheduler failed to start; no directory sources were scheduled',
    );
    return null;
  }

  await scheduleBackgroundWork(scheduler, logger);

  return scheduler;
}
