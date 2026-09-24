import { webhookCreateRequest, webhookDeliveryListResponse, webhookListResponse, webhookSecretResponse, webhookUpdateRequest } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `webhooks.ts`. See openapi/describe.ts. */
export const webhooksOpenApi = describeAdminRoutes('Webhooks', {
  'GET /webhooks': {
    summary: 'List webhook endpoints with their delivery health',
    response: webhookListResponse,
  },
  'POST /webhooks': {
    summary: 'Create a webhook endpoint',
    description: 'The response carries the signing secret. It is shown once and cannot be read back. Where the tenant holds this change class for a second administrator (Change control), the change is not applied: the answer is `202` with the stored change request, given a reason in the `X-Syntra-Change-Reason` header, or `409 change-approval-required` without one. On approval the secret goes to the approver.',
    body: webhookCreateRequest,
    response: webhookSecretResponse,
    status: 201,
  },
  'PUT /webhooks/:id': {
    summary: 'Update a webhook endpoint',
    description: 'Where the tenant holds this change class for a second administrator (Change control), the change is not applied: the answer is `202` with the stored change request, given a reason in the `X-Syntra-Change-Reason` header, or `409 change-approval-required` without one.',
    body: webhookUpdateRequest,
  },
  'POST /webhooks/:id/secret': {
    summary: 'Rotate a webhook endpoint\'s signing secret',
    description: 'The response carries the new secret, shown once.',
    response: webhookSecretResponse,
  },
  'DELETE /webhooks/:id': { summary: 'Delete a webhook endpoint', status: 204 },
  'GET /webhooks/:id/deliveries': {
    summary: 'List recent deliveries to a webhook endpoint',
    response: webhookDeliveryListResponse,
  },
  'POST /webhooks/:id/deliveries/:deliveryId/retry': { summary: 'Retry a failed webhook delivery' },
});
