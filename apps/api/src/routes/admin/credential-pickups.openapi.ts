import {
  credentialPickupHistoryResponse,
  sendLoginInfoRequest,
  sendLoginInfoResponse,
} from '@syntra/contracts';
import { placementParams } from './targets.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `credential-pickups.ts`. See openapi/describe.ts. */
export const credentialPickupsOpenApi = describeAdminRoutes('Target systems', {
  'GET /targets/:id/accounts/:personId/credential-pickups': {
    summary: "List the one-time sign-in links sent for a person's account",
    description:
      'Newest first, at most 50. Each row says who it was sent to (`personalEmail`, `manager` or `admin`, never an address) and whether it was viewed, revoked or has expired. `hasInitialSecret` says whether there is an initial password to send another link to. No token is ever returned: only its hash is stored.',
    params: placementParams,
    response: credentialPickupHistoryResponse,
  },
  'POST /targets/:id/accounts/:personId/send-login-info': {
    summary: "Send a new one-time sign-in link for a person's account",
    description:
      "Revokes every unviewed link for the account, mints a new one (72 hours) and mails it to the chosen recipient: the account profile's configured one, the person's personal email, their manager, or the calling administrator. The message holds a link, never the password. Needs a console session elevated within the step-up window (`403 step-up-required` otherwise). Answers `409 no-initial-secret` when Syntra holds no initial password for the account and `409 no-delivery-address` when the recipient has no address. `delivered` is false when the mail transport refused the message; the link exists either way.",
    params: placementParams,
    body: sendLoginInfoRequest,
    response: sendLoginInfoResponse,
  },
});
