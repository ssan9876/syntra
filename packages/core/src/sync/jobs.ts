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
