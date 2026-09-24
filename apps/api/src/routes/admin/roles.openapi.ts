import { idParam, patchRoleBody, roleAssignmentBody, roleAssignmentParams, roleAssignmentQuery, roleBody } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `roles.ts`. See openapi/describe.ts. */
export const rolesOpenApi = describeAdminRoutes('Roles', {
  'GET /roles/presets': { summary: 'List the built-in role presets' },
  'POST /roles/presets/:key': {
    summary: 'Create a role from a preset',
    description: 'Refused with `role-exists` when a role of the preset\'s name already exists.',
    status: 201,
  },
  'GET /roles': {
    summary: 'List roles with their assignment counts and the permission catalog',
  },
  'POST /roles': { summary: 'Create a role', body: roleBody, status: 201 },
  'PATCH /roles/:id': {
    summary: 'Update a role',
    description: 'Refused with `would-strand-rbac` if nobody would be left holding `rbac.manage`. Adding a privileged permission is a privileged role grant. Where the tenant holds this change class for a second administrator (Change control), the change is not applied: the answer is `202` with the stored change request, given a reason in the `X-Syntra-Change-Reason` header, or `409 change-approval-required` without one.',
    body: patchRoleBody,
    params: idParam,
    status: 204,
  },
  'DELETE /roles/:id': {
    summary: 'Delete a role',
    description: 'Refused with `would-strand-rbac` if nobody would be left holding `rbac.manage`.',
    params: idParam,
    status: 204,
  },
  'POST /roles/:id/assignments': {
    summary: 'Assign a role to a user',
    description: 'Assigning a role that carries a privileged permission is a privileged role grant. Where the tenant holds this change class for a second administrator (Change control), the change is not applied: the answer is `202` with the stored change request, given a reason in the `X-Syntra-Change-Reason` header, or `409 change-approval-required` without one.',
    body: roleAssignmentBody,
    params: idParam,
    status: 204,
  },
  'DELETE /roles/:id/assignments/:userId': {
    summary: 'Revoke a role from a user',
    description: 'Refused with `would-strand-rbac` if nobody would be left holding `rbac.manage`.',
    query: roleAssignmentQuery,
    params: roleAssignmentParams,
    status: 204,
  },
});
