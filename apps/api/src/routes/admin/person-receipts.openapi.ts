import { idParam } from '@syntra/contracts';
import { provisionReceiptRequest, receiptParams } from './person-receipts.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `person-receipts.ts`. See openapi/describe.ts. */
export const personReceiptsOpenApi = describeAdminRoutes('Person receipts', {
  'GET /persons/:id/provision-receipts': {
    summary: "List a person's most recent provisioning receipts",
    params: idParam,
  },
  'POST /persons/:id/provision-receipts': {
    summary: 'Provision one person to every enabled target, or to the named ones',
    description:
      'Queued, not applied inline: answers with one receipt per target to follow. `requestKey` is an idempotency key — repeating a request with the same key for the same person returns the receipts it already created instead of queueing the work again.',
    body: provisionReceiptRequest,
    params: idParam,
    status: 202,
  },
  'POST /persons/:id/provision-receipts/:receiptId/retry': {
    summary: 'Retry one provisioning receipt',
    description: 'Queued, not applied inline; answers with the receipt to follow.',
    params: receiptParams,
    status: 202,
  },
});
