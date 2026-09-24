import { startRequest } from './update.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `update.ts`. These act on the
 * DEPLOYMENT, not the tenant: they install or roll back a release of the
 * server itself, on installs that were set up for in-place updates.
 */
export const updateOpenApi = describeAdminRoutes('Deployment updates', {
  'GET /update': { summary: 'Check for a newer release and read update progress' },
  'GET /update/status': { summary: 'Read the progress of the running or last update' },
  'POST /update': {
    summary: 'Start updating the deployment to a newer release',
    description:
      'Accepted, not finished: the updater runs outside this process and restarts the server, so poll `GET /api/admin/update/status`. Refused with `409 update-in-progress` while an update runs, `409 updates-not-configured` without release configuration, and `422 not-newer` for a version that is not newer.',
    body: startRequest,
    status: 202,
  },
  'POST /update/rollback': {
    summary: 'Roll the deployment back to the previous release',
    description:
      'Accepted, not finished; poll `GET /api/admin/update/status`. Refused with `409 update-in-progress` while an update runs.',
    status: 202,
  },
});
