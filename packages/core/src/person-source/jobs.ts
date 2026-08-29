import { withTenant } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PersonSourceDisabledError } from './source-service.js';
import { applyImportRun, previewImportRun } from './run-service.js';

export const PERSON_IMPORT_JOB = 'personSource.run';

export interface PersonImportJobPayload {
  tenantId: string;
  sourceId: string;
  /**
   * A run row created before the job was enqueued, so a caller can be told
   * which run its request produced without waiting for the SFTP read. Absent
   * on the scheduled path, which has nobody to tell.
   */
  runId?: string;
}

export interface SchedulablePersonSource {
  id: string;
  schedule: string | null;
  enabled: boolean;
}

/**
 * `key` is not optional in practice, for the reason `Scheduler.schedule`
 * records: pg-boss keys its schedule table on `(name, key)`, so two sources
 * scheduled without one are the same row and all but the last stop running.
 */
function scheduleKey(tenantId: string, sourceId: string): string {
  return `${tenantId}:${sourceId}`;
}

/**
 * Queues a manual run and hands back the row it will fill in.
 *
 * The row is created here rather than in the worker so the response can name
 * it. `queued` is a real state, distinct from `running`: between the two the
 * job sits in the queue for as long as the queue is busy, and a screen showing
 * `running` for that window would be lying about the source.
 */
export async function queueImportRun(
  scheduler: Scheduler,
  tenantId: string,
  sourceId: string,
) {
  const run = await withTenant(tenantId, async (tx) => {
    const source = await tx.personSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`no such person source: ${sourceId}`);
    // Refused HERE rather than in the route, for the reason SourceDisabledError
    // records: a check in the route leaves the hole open for the next caller,
    // and a run that reaches the database is a run somebody has to reap.
    if (!source.enabled) throw new PersonSourceDisabledError(sourceId);
    const boundTenant = await currentTenant(tx);
    return tx.personImportRun.create({
      data: { tenantId: boundTenant, sourceId, status: 'queued' },
    });
  });

  await scheduler.enqueue(PERSON_IMPORT_JOB, {
    tenantId,
    sourceId,
    runId: run.id,
  } satisfies PersonImportJobPayload);

  return run;
}

/**
 * Brings the scheduler into line with one source's current settings.
 *
 * A source that is disabled or has no cron expression is unscheduled rather
 * than skipped. Skipping would be right only if it had never been scheduled;
 * for one whose `enabled` was just turned off it would leave the old schedule
 * firing against a source the administrator believes is stopped.
 */
export async function applyPersonSourceSchedule(
  scheduler: Scheduler,
  tenantId: string,
  source: SchedulablePersonSource,
): Promise<void> {
  const key = scheduleKey(tenantId, source.id);

  if (!source.enabled || !source.schedule) {
    await scheduler.unschedule(PERSON_IMPORT_JOB, key);
    return;
  }

  await scheduler.schedule(
    PERSON_IMPORT_JOB,
    source.schedule,
    { tenantId, sourceId: source.id } satisfies PersonImportJobPayload,
    key,
  );
}

export async function removePersonSourceSchedule(
  scheduler: Scheduler,
  tenantId: string,
  sourceId: string,
): Promise<void> {
  await scheduler.unschedule(PERSON_IMPORT_JOB, scheduleKey(tenantId, sourceId));
}

/**
 * The unattended path.
 *
 * `confirm` is never passed, so a blocked run cannot be applied here whatever
 * `autoApply` says. That is the whole protection: an unattended schedule is
 * exactly when nobody is watching.
 */
export async function runPersonImportJob(
  provider: MasterKeyProvider,
  payload: PersonImportJobPayload,
): Promise<void> {
  const source = await withTenant(payload.tenantId, (tx) =>
    tx.personSource.findUnique({ where: { id: payload.sourceId } }),
  );
  if (!source || !source.enabled) return;

  const run = await previewImportRun(
    payload.tenantId,
    provider,
    payload.sourceId,
    payload.runId,
  );

  if (source.autoApply && run.status === 'previewed') {
    await applyImportRun(payload.tenantId, run.id);
  }
}

export function registerPersonImportJobs(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
): void {
  scheduler.register<PersonImportJobPayload>(PERSON_IMPORT_JOB, (payload) =>
    runPersonImportJob(provider, payload),
  );
}
