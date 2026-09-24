import { exportListQuery, exportRequestBody, idParam } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `exports.ts`. See
 * openapi/describe.ts.
 *
 * None of these routes carries a route-level permission guard, so the document
 * lists none: what an export needs depends on its KIND (`audit.read` for the
 * audit log, `govern.read` and `govern.export` for Governance access), and the
 * service checks it at request, at generation and at every download.
 */
export const exportsOpenApi = describeAdminRoutes('Exports', {
  'POST /exports': {
    summary: 'Request an asynchronous export',
    description:
      'Answers 202 with the queued export. A background job generates the file in bounded batches, watermarks it with the export id, tenant, requester and time, records its SHA-256 and seals it at rest. The requester must hold the permissions of the kind, and a machine token must also hold them in its own scopes.',
    body: exportRequestBody,
  },
  'GET /exports': {
    summary: 'List exports',
    description: '`scope=all` lists every administrator\'s exports and needs `tenant.manage`; otherwise your own.',
    query: exportListQuery,
  },
  'GET /exports/:id': {
    summary: 'Read one export\'s status',
    params: idParam,
  },
  'GET /exports/:id/download': {
    summary: 'Download a ready export',
    description:
      'Only the requester, only while it is ready and unexpired, and only while they still hold the permission it was generated under; a changed Governance scope refuses. The digest is re-checked after decryption and returned in a header. Every download is audited.',
    params: idParam,
  },
  'POST /exports/:id/revoke': {
    summary: 'Revoke an export and erase its file',
    description: 'By the requester, or by an administrator holding `tenant.manage`.',
    params: idParam,
  },
});
