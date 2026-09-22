import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../jobs/scheduler.js';
import { LIFECYCLE_MAINTENANCE_JOB, registerLifecycleJobs, scheduleLifecycleMaintenance } from './jobs.js';

function scheduler(): Scheduler {
  return {
    start: vi.fn(), stop: vi.fn(), register: vi.fn(), enqueue: vi.fn(), schedule: vi.fn(), unschedule: vi.fn(), missingSchedules: vi.fn(),
  } as unknown as Scheduler;
}

describe('lifecycle maintenance jobs', () => {
  it('registers one maintenance worker and schedules each tenant independently', async () => {
    const worker = scheduler();
    registerLifecycleJobs(worker);
    await scheduleLifecycleMaintenance(worker, 'tenant-1');
    expect(worker.register).toHaveBeenCalledWith(LIFECYCLE_MAINTENANCE_JOB, expect.any(Function));
    expect(worker.schedule).toHaveBeenCalledWith(
      LIFECYCLE_MAINTENANCE_JOB,
      '17 * * * *',
      { tenantId: 'tenant-1' },
      'lifecycle-maintenance-tenant-1',
    );
  });
});
