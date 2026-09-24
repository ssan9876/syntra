import { assignApplicationRequest, assignmentParams, catalogCreateRequest, catalogCreateResponse, createApplicationRequest, idParam, updateApplicationRequest } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `applications.ts`. See openapi/describe.ts. */
export const applicationsOpenApi = describeAdminRoutes('Applications', {
  'GET /applications': { summary: 'List applications' },
  'GET /catalog': {
    summary: 'List the application catalog',
    description: 'The applications Syntra knows how to configure. Identical for every tenant.',
  },
  'POST /applications/from-catalog': {
    summary: 'Create an application from a catalog entry',
    description: 'Establishes the tenant\'s SAML signing key first when the entry needs one.',
    body: catalogCreateRequest,
    response: catalogCreateResponse,
    status: 201,
  },
  'POST /applications': { summary: 'Create an application', body: createApplicationRequest, status: 201 },
  'PUT /applications/:id': { summary: 'Replace an application', body: updateApplicationRequest, params: idParam },
  'GET /applications/:id/assignments': { summary: 'List who is assigned an application', params: idParam },
  'POST /applications/:id/assignments': {
    summary: 'Assign an application to a user or group',
    body: assignApplicationRequest,
    params: idParam,
    status: 201,
  },
  'DELETE /applications/:id/assignments/:assignmentId': {
    summary: 'Remove an application assignment',
    params: assignmentParams,
    status: 204,
  },
});
