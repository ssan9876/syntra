import { sourceIdQuery } from './list-query.js';
import { applyRunRequest, cancelRunRequest, idParam } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `sync-runs.ts`. See openapi/describe.ts. */
export const syncRunsOpenApi = describeAdminRoutes('Directory sync runs', {
  'GET /sync-runs': { summary: 'List directory sync runs, optionally for one source', query: sourceIdQuery },
  'GET /sync-runs/:id': { summary: 'Read a sync run and its proposed changes', params: idParam },
  'POST /sync-runs/:id/apply': {
    summary: 'Apply the proposed changes of a sync run',
    description:
      'Applies every proposed change, or only those named in `only`. A run whose change volume tripped the safety threshold answers 409 `run-blocked` until it is applied again with `confirm: true`.',
    body: applyRunRequest,
    params: idParam,
  },
  'POST /sync-runs/:id/cancel': {
    summary: 'Cancel a sync run',
    description:
      'A queued or review-pending run is cancelled at once. A run that is reading or applying is asked to stop and does so at its next checkpoint, between changes and never inside one, so the answer may be `requested`. A finished run answers 409 `run-not-cancellable`.',
    body: cancelRunRequest,
    params: idParam,
  },
  'POST /sync-changes/:id/skip': {
    summary: 'Skip one proposed change of a sync run',
    description: 'Only a change still `proposed` can be skipped; anything else answers 409.',
    params: idParam,
    status: 204,
  },
});
