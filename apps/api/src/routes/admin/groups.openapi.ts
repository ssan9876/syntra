import { createGroupRequest, deactivateGroupRequest, idParam, membershipParams, patchGroupRequest } from '@syntra/contracts';
import { statusPageQuery } from './list-query.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `groups.ts`. See openapi/describe.ts. */
export const groupsOpenApi = describeAdminRoutes('Groups', {
  'POST /groups/:id/deactivate': {
    summary: 'Deactivate a group',
    description: 'Groups are never deleted: deactivation records the reason and can be reversed with reactivate.',
    body: deactivateGroupRequest,
    params: idParam,
  },
  'POST /groups/:id/reactivate': { summary: 'Reactivate a deactivated group', params: idParam },
  'GET /groups': { summary: 'List groups', query: statusPageQuery },
  'GET /groups/:id': { summary: 'Get a group', params: idParam },
  'POST /groups': { summary: 'Create a group', body: createGroupRequest, status: 201 },
  'GET /groups/:id/members': { summary: 'List the members of a group', params: idParam },
  'POST /groups/:id/members/:userId': { summary: 'Add a user to a group', params: membershipParams, status: 204 },
  'DELETE /groups/:id/members/:userId': { summary: 'Remove a user from a group', params: membershipParams, status: 204 },
  'PATCH /groups/:id': { summary: 'Update a group', body: patchGroupRequest, params: idParam },
});
