import { createSourceRequest, idParam, setMappingsRequest, testConnectionRequest, updateSourceRequest } from '@syntra/contracts';
import { deleteQuery } from './sources.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `sources.ts`. See openapi/describe.ts. */
export const sourcesOpenApi = describeAdminRoutes('Directory sources', {
  'GET /sources': { summary: 'List directory sources' },
  'GET /sources/mapping-defaults': {
    summary: 'Read the default attribute mappings and assignable fields',
    description: 'The per-directory-flavour defaults a new mapping starts from, and the fields a mapping may write.',
  },
  'GET /sources/:id': { summary: 'Read a directory source and the objects it owns', params: idParam },
  'GET /sources/:id/mappings': { summary: "Read a directory source's attribute mappings", params: idParam },
  'POST /sources/test': {
    summary: 'Test an unsaved directory connection and discover its schema',
    description:
      'Nothing is saved. A failed connection is reported in the response, not as an error. Naming a saved `sourceId` without a password reuses the stored credential only for that source\'s saved address and transport; a request that changes either must supply the password.',
    body: testConnectionRequest,
  },
  'POST /sources': { summary: 'Create a directory source', body: createSourceRequest, status: 201 },
  'PATCH /sources/:id': { summary: 'Update a directory source', body: updateSourceRequest, params: idParam },
  'DELETE /sources/:id': {
    summary: 'Delete a directory source',
    description:
      'Deleting a source that owns users, groups or organizational units requires `?confirm=true` together with the three `ack*` counts the caller was shown; if the counts no longer match, the delete is refused rather than applied to numbers nobody confirmed.',
    query: deleteQuery,
    params: idParam,
    status: 204,
  },
  'PUT /sources/:id/mappings': {
    summary: "Replace a directory source's attribute mappings",
    body: setMappingsRequest,
    params: idParam,
  },
  'POST /sources/:id/test': {
    summary: 'Test the connection of a saved directory source',
    description: 'A failed connection is reported in the response, not as an error.',
    params: idParam,
  },
  'POST /sources/:id/run': {
    summary: 'Start a directory sync run now',
    description:
      'Queues a background run and answers 202 with the run record; follow it with `GET /api/admin/sync-runs/{id}`. Answers 503 when the job scheduler is not running.',
    params: idParam,
    status: 202,
  },
});
