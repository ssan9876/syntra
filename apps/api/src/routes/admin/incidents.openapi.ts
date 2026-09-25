import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `incidents.ts`. See openapi/describe.ts. */
export const incidentsOpenApi = describeAdminRoutes('Incidents', {
  'GET /incidents': {
    summary: 'List current operational incidents',
    description:
      'Derived on each request from the tenant\'s failing work and from background-job health; there is nothing to acknowledge or store.',
  },
  'GET /attention/summary': {
    summary: 'Summarise work waiting for a person',
    description:
      'Counts and the oldest items of work that needs a decision: provisioning runs held for review (`previewed` or `blocked`, with the target, the run and the guard\'s reason), lifecycle operations that failed or are waiting on read-back verification, and pending privileged change requests. ' +
      'Any signed-in administrator may call it; each section is read only when the caller may read what it lists (`provision.read` for runs and lifecycle work; `tenant.manage`, `rbac.manage` or `token.manage` for change requests) and is `null` otherwise. ' +
      'Items are capped at 10 per section; counts are totals. Nothing is stored or acknowledged: an item disappears when the work behind it is done.',
  },
});
