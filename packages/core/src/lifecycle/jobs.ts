import type { Scheduler } from '../jobs/scheduler.js';
import { maintainLifecycleOperations } from './management.js';
import { runLifecycleRetention } from './retention.js';

export const LIFECYCLE_MAINTENANCE_JOB = 'lifecycle.maintenance';
export const LIFECYCLE_RETENTION_JOB = 'lifecycle.retention';
export interface LifecycleMaintenancePayload { tenantId: string }

export function registerLifecycleJobs(scheduler: Scheduler, options: { publicUrl?: string } = {}): void {
  scheduler.register<LifecycleMaintenancePayload>(LIFECYCLE_MAINTENANCE_JOB, async ({ tenantId }) => {
    await maintainLifecycleOperations(tenantId, new Date(), options);
  });
  scheduler.register<LifecycleMaintenancePayload>(LIFECYCLE_RETENTION_JOB, async ({ tenantId }) => {
    await runLifecycleRetention(tenantId);
  });
}

export async function scheduleLifecycleMaintenance(scheduler: Scheduler, tenantId: string): Promise<void> {
  await scheduler.schedule(LIFECYCLE_MAINTENANCE_JOB, '17 * * * *', { tenantId }, `lifecycle-maintenance-${tenantId}`);
  // Once a day, off-peak, and after the maintenance pass has run for the hour.
  await scheduler.schedule(LIFECYCLE_RETENTION_JOB, '41 3 * * *', { tenantId }, `lifecycle-retention-${tenantId}`);
}
