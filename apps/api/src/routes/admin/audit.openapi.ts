import { auditQuery } from './audit.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `audit.ts`. See openapi/describe.ts. */
export const auditOpenApi = describeAdminRoutes('Audit', {
  'GET /audit': {
    summary: 'List audit events, newest first, with the hash-chain verdict',
    description:
      'Keyset-paged by sequence number: pass the lowest `sequence` of one page as `before` to read the next. `subject` may be repeated to filter to events about particular records. `chainValid` reports whether the tamper-evident hash chain verifies, and `brokenAtSequence` where it does not.',
    query: auditQuery,
  },
});
