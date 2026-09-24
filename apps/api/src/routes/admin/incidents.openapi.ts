import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `incidents.ts`. See openapi/describe.ts. */
export const incidentsOpenApi = describeAdminRoutes('Incidents', {
  'GET /incidents': {
    summary: 'List current operational incidents',
    description:
      'Derived on each request from the tenant\'s failing work and from background-job health; there is nothing to acknowledge or store.',
  },
});
