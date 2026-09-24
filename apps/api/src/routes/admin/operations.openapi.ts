import { jobRepairBody } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `operations.ts`. See openapi/describe.ts. */
export const operationsOpenApi = describeAdminRoutes('Operations', {
  'GET /job-health': {
    summary: "Report this tenant's orphaned, stuck, delayed or poisoned background work",
    description:
      'Compares every non-terminal run, receipt, export and lifecycle operation with the job queue and the clock, and reports what is `orphaned`, `stuck`, `duplicated`, `delayed`, `poisoned` or `saturation_deferred`. Each finding names the row, when the condition started, one sentence of explanation, and the repairs that are safe for it. When the queue cannot be read (`queueReadable: false`) nothing is reported orphaned. Only this tenant\'s rows and jobs are read.',
  },
  'POST /job-health/repair': {
    summary: 'Apply one idempotent, audited repair to a piece of background work',
    description:
      '`requeue` enqueues the job a queued run, export or receipt is missing; `mark_failed` ends a row no worker is running, with the reason; `release_lease` closes a provisioning apply whose heartbeat stopped as partially applied, leaving actions with an unknown outcome for verification against the target before the next run plans. The finding is re-derived when the repair runs: a repair of something already healthy answers `outcome: "noop"`, and a repair that is not safe for the current finding is refused with `409 repair-not-allowed`. Lifecycle operations are refused: retry them from their own page. Every attempt is an audit event (`job_health.<action>`).',
    body: jobRepairBody,
  },
  'GET /status': {
    summary: "Read this tenant's service status",
    description:
      "The shared components (API, database, job queue, key provider, mail) as working or not, and this tenant's own degradation: write stops, stale or failing connector readiness, connector outages and background-work findings. Reports nothing about any other tenant's activity -- not even the queue's depth.",
  },
  'GET /deployment/status': {
    summary: 'Read the installation status for the deployment operator',
    description:
      'The release, the readiness probes (causes redacted), migration state, queue depth, missing schedules and installation-wide counts of background-work findings and of degraded tenants. Counts only: no tenant is named.',
  },
});
