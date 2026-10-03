import { applyGroupRuleRequest, createGroupRequest, deactivateGroupRequest, groupMembershipRuleRequest, idParam, membershipParams, patchGroupRequest } from '@syntra/contracts';
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
  'PUT /groups/:id/rule': {
    summary: 'Set or clear the membership rule',
    description: 'Applies the rule at once. Members the rule adds are removed by it when they stop matching; direct members are never removed by it.',
    body: groupMembershipRuleRequest,
    params: idParam,
  },
  'POST /groups/:id/rule/preview': {
    summary: 'Preview a membership rule',
    body: groupMembershipRuleRequest,
    params: idParam,
  },
  'POST /groups/:id/rule/apply': {
    summary: 'Apply the membership rule now',
    description: 'A pass that would remove more than 25% of the rule members (and more than 5) is refused with 409 rule-held unless confirm is true.',
    body: applyGroupRuleRequest,
    params: idParam,
  },
  'PATCH /groups/:id': { summary: 'Update a group', body: patchGroupRequest, params: idParam },
});
