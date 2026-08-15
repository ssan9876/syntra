import { withTenant } from '@syntra/db';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { applyRun, previewRun } from './run-service.js';

export const SYNC_JOB = 'sync.run';

export interface SyncJobPayload {
  tenantId: string;
  sourceId: string;
}

/** A background job has no request and therefore no bound tenant. */
export function syncJobPayload(
  tenantId: string,
  sourceId: string,
): SyncJobPayload {
  return { tenantId, sourceId };
}

/**
 * The schedule key for one source on the shared `sync.run` queue.
 *
 * pg-boss keys its schedule table on `(queue name, key)`, and `key` defaults
 * to the empty string — so without this, every source scheduled on this queue
 * writes the same row and only the last one survives. The tenant is in the key
 * as well as the source id: ids are unique already, but a key that names both
 * is readable in the schedule table, which is where anyone debugging a
 * schedule that did not fire will be looking.
 */
export function syncScheduleKey(tenantId: string, sourceId: string): string {
  return `${tenantId}/${sourceId}`;
}

/** What scheduling a source needs to know about it. */
export interface SchedulableSource {
  id: string;
  schedule: string | null;
  enabled: boolean;
}

/**
 * Brings the scheduler into line with one source's current settings.
 *
 * Called at boot for every source, and again on every create, update and
 * delete — without which a source created with a cron expression is not
 * scheduled until the process restarts, and one whose schedule was cleared
 * keeps running on the old one.
 *
 * A source that is disabled or has no cron expression is unscheduled rather
 * than skipped. Skipping would be right only if it had never been scheduled;
 * for a source that just had `enabled` turned off it would leave the old
 * schedule firing against a source the administrator believes is stopped.
 */
export async function applySourceSchedule(
  scheduler: Scheduler,
  tenantId: string,
  source: SchedulableSource,
): Promise<void> {
  const key = syncScheduleKey(tenantId, source.id);

  if (!source.enabled || !source.schedule) {
    await scheduler.unschedule(SYNC_JOB, key);
    return;
  }

  await scheduler.schedule(
    SYNC_JOB,
    source.schedule,
    syncJobPayload(tenantId, source.id),
    key,
  );
}

/** Removes a deleted source's schedule, so it cannot fire against nothing. */
export async function removeSourceSchedule(
  scheduler: Scheduler,
  tenantId: string,
  sourceId: string,
): Promise<void> {
  await scheduler.unschedule(SYNC_JOB, syncScheduleKey(tenantId, sourceId));
}

export async function runSyncJob(
  provider: MasterKeyProvider,
  payload: SyncJobPayload,
): Promise<void> {
  const source = await withTenant(payload.tenantId, (tx) =>
    tx.directorySource.findUnique({ where: { id: payload.sourceId } }),
  );
  if (!source || !source.enabled) return;

  // previewRun and applyRun take a tenantId and open their own transactions
  // internally — one per change — because PostgreSQL aborts a transaction on
  // error, so a single caller transaction could not mark a failed change and
  // continue.
  const run = await previewRun(payload.tenantId, provider, payload.sourceId);

  await withTenant(payload.tenantId, (tx) =>
    tx.directorySource.update({
      where: { id: payload.sourceId },
      data: { lastRunAt: new Date() },
    }),
  );

  // The guard is not advisory. A blocked run does not apply, and autoApply
  // does not override it — an unattended schedule is exactly the case it
  // exists for.
  if (source.autoApply && run.status === 'previewed') {
    await applyRun(payload.tenantId, run.id);
  }
}

export function registerSyncJobs(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
): void {
  scheduler.register<SyncJobPayload>(SYNC_JOB, (payload) =>
    runSyncJob(provider, payload),
  );
}
