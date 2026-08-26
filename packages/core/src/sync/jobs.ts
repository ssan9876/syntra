import { withTenant } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { applyRun, previewRun } from './run-service.js';

export const SYNC_JOB = 'sync.run';

export interface SyncJobPayload {
  tenantId: string;
  sourceId: string;
  /**
   * A run row created before the job was enqueued, so a caller could be told
   * which run its request produced without waiting for the directory read.
   * Absent on the scheduled path, which has nobody to tell.
   */
  runId?: string;
}

/** A background job has no request and therefore no bound tenant. */
export function syncJobPayload(
  tenantId: string,
  sourceId: string,
): SyncJobPayload {
  return { tenantId, sourceId };
}

/**
 * Queues a manual run and hands back the row it will fill in.
 *
 * `POST /sources/:id/run` used to perform the whole read-and-diff inside the
 * HTTP request. A directory read is network-bound and unbounded — it is the
 * one operation in this subsystem with no time limit of its own — and holding
 * a request open for it is the shape that outlasts a proxy timeout: the
 * browser is told the run failed while the run carries happily on, and the
 * operator's next move is to press the button again. Section 7 says a run is a
 * job; this makes the manual path the same job the schedule uses.
 *
 * The row is created here rather than in the worker so the response can name
 * it. `queued` is a real state, distinct from `running`: between the two the
 * job sits in pg-boss for as long as the queue is busy, and a screen that
 * showed `running` for that window would be lying about the directory.
 */
/**
 * A run asked for on a source that is switched off.
 *
 * Refused HERE rather than in the route, because this is what writes the row:
 * a check in the route leaves the hole open for the next caller, and a run
 * that reaches the database is a run somebody has to reap.
 */
export class SourceDisabledError extends Error {
  constructor(readonly sourceId: string) {
    super('this source is disabled, so a run would never be picked up');
    this.name = 'SourceDisabledError';
  }
}

export async function queueRun(
  scheduler: Scheduler,
  tenantId: string,
  sourceId: string,
): Promise<{ id: string; status: string }> {
  const run = await withTenant(tenantId, async (tx) => {
    const source = await tx.directorySource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`no such source: ${sourceId}`);
    if (!source.enabled) {
      // `runSyncJob` early-returns for a disabled source WITHOUT touching the
      // run row, and nothing reaps `queued`. So the row sat there for ever,
      // the console followed it, and the page spun with no error recorded --
      // for a source somebody had deliberately switched off. Throwing rolls
      // back the row, so nothing is left behind at all.
      throw new SourceDisabledError(sourceId);
    }
    const boundTenant = await currentTenant(tx);
    return tx.syncRun.create({
      data: { tenantId: boundTenant, sourceId, status: 'queued' },
    });
  });

  // Enqueued AFTER the row commits. The other order races: a worker free at
  // that moment reads a run id that no transaction has written yet.
  await scheduler.enqueue<SyncJobPayload>(SYNC_JOB, {
    tenantId,
    sourceId,
    runId: run.id,
  });
  return run;
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
  const run = await previewRun(payload.tenantId, provider, payload.sourceId, payload.runId);

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
