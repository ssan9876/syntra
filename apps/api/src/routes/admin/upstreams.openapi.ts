import { upstreamIdpRequest } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `upstreams.ts`. See openapi/describe.ts. */
export const upstreamsOpenApi = describeAdminRoutes('Upstream identity providers', {
  'GET /upstreams': { summary: 'List upstream identity providers' },
  'POST /upstreams': {
    summary: 'Register an upstream identity provider',
    body: upstreamIdpRequest,
    status: 201,
  },
});
