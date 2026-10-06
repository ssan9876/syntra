import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `restore-hold.ts`. Like updates,
 * these act on the DEPLOYMENT: a restore holds every tenant at once.
 */
export const restoreHoldOpenApi = describeAdminRoutes('Deployment updates', {
  'GET /restore-hold': {
    summary: 'Read whether a restore is waiting to be resumed',
    description:
      '`hold` is null when nothing is held. `mayResume` says whether the caller holds `deployment.manage`.',
  },
  'POST /restore-hold/resume': {
    summary: 'Resume background work and writes to target systems after a restore',
    description:
      'Releases every unreleased hold. Background work starts on each API process within 15 seconds. Refused with `409 not-held` when nothing is held.',
  },
});
