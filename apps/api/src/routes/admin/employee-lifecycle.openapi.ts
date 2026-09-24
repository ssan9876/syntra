import { idParam } from '@syntra/contracts';
import { employeeWorkQuery, endRequest } from './employee-lifecycle.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `employee-lifecycle.ts`. See openapi/describe.ts. */
export const employeeLifecycleOpenApi = describeAdminRoutes('Employee lifecycle', {
  'GET /persons/:id/offboarding': {
    summary: 'Preview ending a person\'s employment',
    description:
      'Lists the accounts and target access that offboarding would remove, with the `revision` digest the offboarding request must echo.',
    params: idParam,
  },
  'GET /employee-work': {
    summary: 'List the employee onboarding, offboarding and failed-work queue',
    query: employeeWorkQuery,
  },
  'POST /persons/:id/offboarding': {
    summary: 'Offboard a person: block sign-in and revoke target access',
    description:
      'Send the `revision` from the preview; a person changed since answers `409 preview-stale`. Sign-in is blocked at once, while target revocation is queued as a lifecycle operation and may wait for a second approver when policy requires it for an urgent departure. Administrators cannot offboard themselves.',
    body: endRequest,
    params: idParam,
  },
});
