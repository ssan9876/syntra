import { idParam, issueApiTokenRequest } from '@syntra/contracts';
import { tokenParams } from './tokens.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `tokens.ts`. Published although no
 * token may call them (`TOKEN_DENIED_ROUTES`): minting a machine credential is
 * something a signed-in person does, and an integrator should be able to see
 * that here rather than discover it from a 403.
 */
export const tokensOpenApi = describeAdminRoutes('API tokens', {
  'GET /users/:id/tokens': { summary: "List a service account's API tokens", params: idParam },
  'POST /users/:id/tokens': {
    summary: 'Issue an API token for a service account',
    description:
      'The response carries the token secret. It is returned exactly once and cannot be read back; store it immediately.' +
      ' Where the tenant holds this change class for a second administrator (Change control), the change is not applied: the answer is `202` with the stored change request, given a reason in the `X-Syntra-Change-Reason` header, or `409 change-approval-required` without one.',
    body: issueApiTokenRequest,
    params: idParam,
    status: 201,
  },
  'DELETE /users/:id/tokens/:tokenId': {
    summary: 'Revoke an API token',
    params: tokenParams,
    status: 204,
  },
});
