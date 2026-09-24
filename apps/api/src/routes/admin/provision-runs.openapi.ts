import { acknowledgeDriftRequestSchema, applyRunRequestSchema, cancelRunRequest, idParam } from '@syntra/contracts';
import { driftListQuery, runParams } from './provision-runs.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `provision-runs.ts`. See openapi/describe.ts. */
export const provisionRunsOpenApi = describeAdminRoutes('Provisioning runs', {
  'POST /targets/:id/runs': {
    summary: 'Start a provisioning run for a target system',
    description:
      'Enqueues a background run that reads the target and plans its changes, and answers 202 with the `jobId`; the run appears in the run list once the job starts. Answers 503 when the job scheduler is not running.',
    params: idParam,
    status: 202,
  },
  'GET /targets/:id/runs': { summary: "List a target system's most recent provisioning runs", params: idParam },
  'GET /targets/:id/runs/:runId': {
    summary: 'Read a provisioning run and its planned actions',
    params: runParams,
  },
  'POST /targets/:id/runs/:runId/apply': {
    summary: 'Apply the planned actions of a provisioning run',
    description:
      'Applies every planned action, or only those named in `only`. A run blocked by a safety threshold answers 409 `run-needs-confirmation` until it is sent with `confirm: true`; one blocked for a reason that cannot be confirmed away answers 409 `run-unconfirmable`. An active write stop or maintenance window also refuses the apply.',
    body: applyRunRequestSchema,
    params: runParams,
  },
  'POST /targets/:id/runs/:runId/cancel': {
    summary: 'Cancel a provisioning run',
    description:
      'A `previewed` or `blocked` plan is cancelled at once and its actions abandoned. A run still reading the target, or applying to it, stops at its next checkpoint — never between an action being sent and the target answering it — so the answer may be `requested`.',
    body: cancelRunRequest,
    params: runParams,
  },
  'GET /targets/:id/drift': {
    summary: "List a target system's drift findings",
    query: driftListQuery,
    params: idParam,
  },
  'PATCH /drift/:id': {
    summary: 'Mark a drift finding acknowledged or resolved',
    body: acknowledgeDriftRequestSchema,
    params: idParam,
    status: 204,
  },
});
