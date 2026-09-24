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
    description: 'The response carries the signing secret. It is shown once and cannot be read back.',
    body: webhookCreateRequest,
    response: webhookSecretResponse,
    status: 201,
  },
  'PUT /webhooks/:id': { summary: 'Update a webhook endpoint', body: webhookUpdateRequest },
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
