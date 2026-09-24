import { auditSavedViewBody, auditSearchQuery, idParam } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `audit.ts`. See openapi/describe.ts. */
export const auditOpenApi = describeAdminRoutes('Audit', {
  'GET /audit': {
    summary: 'Search audit events, newest first, with the hash-chain verdict',
    description:
      'Every filter is applied on the server. Keyset-paged by sequence number: pass the response\'s `nextBefore` as `before` to read the next (older) page; it is null on the last page. `subject` may be repeated to filter to events done by or to particular records, and `correlation` returns everything one request or job recorded (the `x-correlation-id` of its response). `chainValid` reports whether the tamper-evident hash chain verifies, and `brokenAtSequence` where it does not. To export the results, `POST /exports` with kind `audit_log` and the same filters.',
    query: auditSearchQuery,
  },
  'GET /audit/views': {
    summary: 'List your saved audit searches',
  },
  'PUT /audit/views': {
    summary: 'Save an audit search under a name',
    description: 'Filters only, private to the administrator who saves them. Saving an existing name replaces it.',
    body: auditSavedViewBody,
  },
  'DELETE /audit/views/:id': {
    summary: 'Delete one of your saved audit searches',
    params: idParam,
  },
});
