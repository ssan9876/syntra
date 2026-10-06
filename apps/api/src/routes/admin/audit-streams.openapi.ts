import { auditStreamBody, idParam } from './audit-streams.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `audit-streams.ts`: SIEM export. */
export const auditStreamsOpenApi = describeAdminRoutes('Audit', {
  'GET /audit-streams': {
    summary: "List the tenant's SIEM streams",
    description:
      'Each stream with its delivery state: `status` (`delivering`, `behind`, `failing`, `paused`), `behind` (events written but not yet delivered), and the last delivery and error. The credential is never returned; `hasCredential` says whether one is stored.',
  },
  'POST /audit-streams': {
    summary: 'Stream the audit log to a SIEM',
    description:
      'HTTPS (`json`: an array per batch; `splunk-hec`: Splunk HTTP Event Collector) or syslog over TCP (`json` or `cef` in RFC 5424, TLS by default). `credential` is sent in the `authHeader` header (e.g. `Authorization: Splunk <token>`) and sealed in the vault. `startFrom: beginning` sends the whole log first; the default is events from now on.',
    body: auditStreamBody,
    status: 201,
  },
  'PUT /audit-streams/:id': {
    summary: 'Change a SIEM stream',
    description: 'Omitting `credential` keeps the stored one; `null` removes it. A changed destination starts with no failures recorded.',
    params: idParam,
    body: auditStreamBody,
  },
  'DELETE /audit-streams/:id': { summary: 'Stop streaming to a SIEM and delete the stream', params: idParam, status: 204 },
  'POST /audit-streams/:id/test': {
    summary: "Send a test event to a stream's destination",
    description:
      'One event with action `audit_stream.test`, not recorded in the audit log and not moving the cursor. `422 audit-stream-test-failed` with what the destination answered.',
    params: idParam,
  },
});
