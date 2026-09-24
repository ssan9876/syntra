import { z } from 'zod';

/**
 * Queue recovery controls (backlog #57): the repair a tenant administrator
 * may apply to one piece of background work. The vocabularies mirror
 * `packages/core/src/jobs/job-health.ts`, which decides whether the repair is
 * safe for what it finds at that moment.
 */
export const jobHealthKind = z.enum([
  'sync_run',
  'person_import_run',
  'provision_run',
  'person_provision_receipt',
  'data_export',
  'lifecycle_operation',
  'scheduled_job',
]);

export const jobRepairBody = z
  .object({
    kind: jobHealthKind,
    /** The row the finding names: a run, receipt or export id. */
    subjectId: z.string().uuid(),
    action: z.enum(['requeue', 'mark_failed', 'release_lease']),
    /** Why. Recorded on the audit event and, for mark failed, on the row. */
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export type JobRepairBody = z.infer<typeof jobRepairBody>;
