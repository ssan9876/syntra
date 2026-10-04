import { setupRequest, setupResponse, setupStatusQuery, setupStatusResponse } from '@syntra/contracts';
import { describePublicRoutes } from '../openapi/describe.js';

/** The OpenAPI description of the routes in `setup.ts`. */
export const setupOpenApi = describePublicRoutes('First-run setup', {
  'GET /api/setup': {
    summary: 'Check a first-run setup link',
    description:
      'Answers only while the database has no tenant, and only with the token the API printed to its log at startup. `403 setup-link-invalid` for a missing or wrong token, `410 setup-link-expired` an hour after startup, and `404` once any tenant exists, whatever the token. Answers carry `Cache-Control: no-store`.',
    noTenant: true,
    query: setupStatusQuery,
    response: setupStatusResponse,
  },
  'POST /api/setup': {
    summary: 'Create the first tenant and its Owner',
    description:
      'Creates the tenant and its first administrator, who holds the built-in Owner role and signs in with the admin email, and records `tenant.created`. The token is spent on success: a second call answers `404`, as does any call once a tenant exists. Refusals are those of `GET /api/setup`, plus `400 weak-password` for a password the policy refuses and `409 setup-in-progress` while another call is creating the tenant.',
    noTenant: true,
    body: setupRequest,
    response: setupResponse,
    status: 201,
  },
});
