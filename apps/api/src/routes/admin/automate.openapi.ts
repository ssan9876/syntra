import { approvalDelegationBody, audiencePreviewBody, decideRequestBody, delegatedTaskRequest, idParam, productBody, resolutionPreviewBody, resourceDelegationBody, resourceOwnerBody, revokeGrantBody, settingsBody, sweepApplyBody, workflowBody } from '@syntra/contracts';
import { requestListQuery } from './automate.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `automate.ts`: delegated tasks,
 * the requestable-access catalog (products and approval workflows), access
 * requests and their decisions, and expiry sweeps.
 */
export const automateOpenApi = describeAdminRoutes('Automate', {
  'GET /automate/tasks/actions': {
    summary: 'List the actions a delegated task may perform',
  },
  'GET /automate/tasks': { summary: 'List delegated tasks' },
  'POST /automate/tasks': {
    summary: 'Create a delegated task',
    description: 'Refused with `400 unknown-action` or `400 form-missing-input` when the form does not supply what the action needs.',
    body: delegatedTaskRequest,
    status: 201,
  },
  'PUT /automate/tasks/:id': {
    summary: 'Replace a delegated task',
    body: delegatedTaskRequest,
    params: idParam,
  },
  'DELETE /automate/tasks/:id': { summary: 'Delete a delegated task', params: idParam, status: 204 },
  'GET /automate/tasks/:id/runs': { summary: 'List the runs of a delegated task', params: idParam },
  'GET /automate/products': { summary: 'List requestable access products' },
  'GET /automate/products/:id': { summary: 'Read a requestable access product', params: idParam },
  'POST /automate/products/audience-preview': {
    summary: 'Preview who a product audience would include',
    description: 'Changes nothing.',
    body: audiencePreviewBody,
  },
  'POST /automate/products': { summary: 'Create a requestable access product', body: productBody, status: 201 },
  'PUT /automate/products/:id': {
    summary: 'Replace a requestable access product',
    body: productBody,
    params: idParam,
    status: 204,
  },
  'GET /automate/workflows': { summary: 'List approval workflows' },
  'POST /automate/workflows': { summary: 'Create an approval workflow', body: workflowBody, status: 201 },
  'PUT /automate/workflows/:id': {
    summary: 'Replace an approval workflow',
    body: workflowBody,
    params: idParam,
    status: 204,
  },
  'POST /automate/workflows/resolution-preview': {
    summary: 'Preview who would approve a request under a workflow',
    description: 'Changes nothing.',
    body: resolutionPreviewBody,
  },
  'GET /automate/requests': { summary: 'List access requests', query: requestListQuery },
  'GET /automate/requests/:id': {
    summary: 'Read an access request with its decisions and notifications',
    params: idParam,
  },
  'POST /automate/requests/:id/decide': {
    summary: 'Approve or reject an access request',
    description:
      'A requester cannot decide their own request (`403 self-approval`); a request that is no longer pending answers `409`.',
    body: decideRequestBody,
    params: idParam,
  },
  'GET /automate/sweeps': { summary: 'List the 50 most recent access-expiry sweeps' },
  'GET /automate/sweeps/:id': {
    summary: 'Read an access-expiry sweep with its actions and exceptions',
    params: idParam,
  },
  'POST /automate/sweeps': {
    summary: 'Preview an access-expiry sweep',
    description: 'Records what would expire; nothing is revoked until the sweep is applied.',
    status: 201,
  },
  'POST /automate/sweeps/:id/apply': {
    summary: 'Apply a previewed access-expiry sweep',
    description: 'Revokes the expired grants the preview found, or only the ones named in `only`. A sweep the mass-change guard blocked is applied only with `confirm: true`, and only when the guard allows confirmation at all.',
    body: sweepApplyBody,
    params: idParam,
  },
  'GET /automate/settings': { summary: 'Read Automate settings' },
  'PUT /automate/settings': { summary: 'Replace Automate settings', body: settingsBody, status: 204 },
  'PUT /automate/resource-owners': {
    summary: 'Set the owner of a resource',
    body: resourceOwnerBody,
    status: 204,
  },
  'POST /automate/resource-delegations': {
    summary: "Delegate a resource owner's responsibilities",
    body: resourceDelegationBody,
    status: 201,
  },
  'POST /automate/approval-delegations': {
    summary: "Delegate a person's approvals to someone else",
    body: approvalDelegationBody,
    status: 201,
  },
  'DELETE /automate/approval-delegations/:id': {
    summary: 'Remove an approval delegation',
    params: idParam,
    status: 204,
  },
  'POST /automate/grants/:id/revoke': {
    summary: 'Revoke an access grant',
    body: revokeGrantBody,
    params: idParam,
    status: 204,
  },
});
