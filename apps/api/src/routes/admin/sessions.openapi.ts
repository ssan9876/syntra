import { idParam, revokeTenantSessionsRequest } from '@syntra/contracts';
import { sessionParams } from './sessions.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `sessions.ts`. See openapi/describe.ts. */
export const sessionsOpenApi = describeAdminRoutes('Sessions', {
  'GET /users/:id/sessions': { summary: "List a user's active sessions", params: idParam },
  'DELETE /users/:id/sessions/:sessionId': {
    summary: 'End one session of a user',
    params: sessionParams,
    status: 204,
  },
  'POST /users/:id/sessions/revoke': {
    summary: 'End every session of a user',
    description:
      "Also revokes the user's refresh tokens and sends back-channel logout to relying parties. Answers with the number of sessions ended.",
    params: idParam,
  },
  'POST /sessions/revoke': {
    summary: 'End every session in the tenant, or every console session',
    description:
      'Needs a console session elevated within the step-up window (`403 step-up-required` otherwise) and a recorded reason; API tokens are refused. Refresh tokens and back-channel logout follow each ended session.',
    body: revokeTenantSessionsRequest,
  },
});
