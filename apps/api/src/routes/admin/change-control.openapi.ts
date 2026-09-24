import { changeControlPolicyBody, changeDecisionBody, changeRequestParams } from './change-control.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `change-control.ts`. Published
 * session-only: a token is refused at every one (`TOKEN_DENIED_ROUTES`), and
 * approval needs a recently stepped-up session a token can never be.
 */
export const changeControlOpenApi = describeAdminRoutes('Change control', {
  'GET /change-control': {
    summary: 'Get the privileged change policy and the queue of held changes',
    description: 'Lists which privileged change classes the tenant holds for a second administrator, the class catalogue, and recent change requests (pending ones past their 72-hour window are closed as expired first).',
  },
  'PUT /change-control/policy': {
    summary: 'Set which privileged change classes are held for a second administrator',
    description: 'Turning a class on applies at once. Turning one off is itself held: the response is `202` with the change request, and needs a reason in the `X-Syntra-Change-Reason` header (URI-encoded) — without one the answer is `409 change-approval-required`.',
    body: changeControlPolicyBody,
  },
  'POST /change-control/requests/:id/approve': {
    summary: 'Approve and apply a held privileged change',
    description: 'Four-eyes: never the requester, and only an administrator holding the permission the change class needs, from a console session stepped up in the last ten minutes. Refused as `stale` (and the request invalidated) if the object it changes was modified after the request. The change is applied in the same transaction; for a token or a new webhook endpoint the response carries its secret, returned once.',
    params: changeRequestParams,
    body: changeDecisionBody,
  },
  'POST /change-control/requests/:id/reject': {
    summary: 'Reject a held privileged change',
    description: 'Never the requester, who may withdraw instead.',
    params: changeRequestParams,
    body: changeDecisionBody,
  },
  'POST /change-control/requests/:id/withdraw': {
    summary: 'Withdraw your own held privileged change',
    params: changeRequestParams,
  },
});
